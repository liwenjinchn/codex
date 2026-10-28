import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as httpServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { KeyPool } from '../src/pool.js';
import { loadConfig } from '../src/config.js';
import { compact, createServer } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const config = extra => ({ ...loadConfig({ EXA_API_KEYS: '["secret-one","secret-two","secret-three"]' }), ...extra });
const ok = () => new Response(JSON.stringify({ results: [{ url: 'https://example.com', text: 'body' }] }));
const fail = (status, seconds = '60') => new Response('error', { status, headers: { 'retry-after': seconds } });
const deferred = () => Promise.withResolvers();

test('concurrent 503 prevents another request rotating after 402', async () => {
  const a = deferred(), b = deferred(); let calls = 0;
  const pool = new KeyPool(config(), { fetchImpl: () => [a.promise, b.promise, Promise.resolve(ok())][calls++] });
  const first = pool.request('/search', {}).catch(e => e.code);
  const second = pool.request('/search', {}).catch(e => e.code);
  a.resolve(fail(503)); assert.equal(await first, 'UPSTREAM_UNAVAILABLE');
  b.resolve(fail(402)); assert.equal(await second, 'SERVICE_COOLDOWN');
  assert.equal(calls, 2);
});

test('concurrent short service cooldown never overwrites longer Retry-After', async () => {
  const a = deferred(), b = deferred(); let calls = 0;
  const pool = new KeyPool(config(), { now: () => 1000, fetchImpl: () => [a.promise, b.promise][calls++] });
  const first = pool.request('/search', {}).catch(e => e.code);
  const second = pool.request('/search', {}).catch(e => e.code);
  a.resolve(fail(503, '900')); await first;
  b.resolve(fail(503, '20')); await second;
  assert.equal(pool.status().serviceRetryAfterSeconds, 900);
});

test('204 is an invalid response, not a network error that spends another key', async () => {
  let calls = 0;
  const pool = new KeyPool(config(), { fetchImpl: async () => ++calls === 1 ? new Response(null, { status: 204 }) : ok() });
  await assert.rejects(pool.request('/search', {}), { code: 'INVALID_RESPONSE' });
  assert.equal(calls, 1);
});

test('programming errors are not transport retries', async () => {
  let calls = 0;
  const pool = new KeyPool(config(), { fetchImpl: async () => { calls++; throw new TypeError('a local programming error'); } });
  await assert.rejects(pool.request('/search', {}), { code: 'INTERNAL_ERROR' });
  assert.equal(calls, 1);
  assert.equal(pool.status().keys[0].state, 'ready');
});

test('body cleanup rejection must not hide 429 and Retry-After', async () => {
  let calls = 0;
  const response = { ok: false, status: 429, headers: new Headers({ 'retry-after': '900' }), body: { cancel: async () => { throw new Error('cleanup failed'); } } };
  const pool = new KeyPool(config(), { fetchImpl: async () => ++calls === 1 ? response : ok(), now: () => 1000 });
  await pool.request('/search', {});
  assert.equal(pool.status().keys[0].retryAfterSeconds, 900);
  assert.equal(pool.status().keys[0].reason, 'rate_limited');
});

test('response normalization skips malformed rows, preserves valid citation URLs', () => {
  const longUrl = 'https://example.com/?q=' + 'a'.repeat(3000);
  const output = compact({ results: [null, { url: longUrl }, { url: 'https://example.com/docs#section', text: 'x' }], warnings: [{ code: 'info', message: 'hello', requestTags: 'private-metadata' }] });
  assert.equal(output.results.length, 1);
  assert.equal(output.results[0].url, 'https://example.com/docs#section');
  assert.equal(output.truncated, true);
  assert.ok(!JSON.stringify(output).includes('private-metadata'));
});

test('redaction of escaped keys preserves JSON and removes secrets', async () => {
  const secret = 'special"key\\value';
  const pool = new KeyPool(config({ keys: [secret] }), { fetchImpl: async () => new Response(JSON.stringify({ results: [{ url: 'https://example.com', text: secret }] })) });
  const server = createServer(pool), client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const response = await client.callTool({ name: 'exa_search', arguments: { query: 'test' } });
    const value = JSON.parse(response.content[0].text);
    assert.equal(value.results[0].content, '[REDACTED]');
  } finally { await client.close(); await server.close(); }
});

test('stdin EOF terminates child even when other handles remain', { timeout: 3000 }, async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', "await import('./src/index.js'); setInterval(() => {}, 1000); process.stderr.write('ready\\n');"], { env: { ...process.env, EXA_API_KEYS: '["fake-key"]', EXA_KEYS_FILE: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await once(child.stderr, 'data');
    const exited = once(child, 'exit');
    child.stdin.end();
    const outcome = await Promise.race([exited, sleep(800).then(() => 'hung')]);
    assert.notEqual(outcome, 'hung');
    assert.equal(outcome[0], 0);
  } finally { child.kill('SIGKILL'); }
});

// Native fetch + real loopback sockets, not synthetic Response-only mocks.
async function networkFixture(handler, extra = {}) {
  const server = httpServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const pool = new KeyPool(config(extra), { fetchImpl: (_url, options) => fetch(`http://127.0.0.1:${server.address().port}`, options) });
  return { pool, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('native fetch: stalled response body obeys total deadline', { timeout: 3000 }, async () => {
  let calls = 0;
  const { pool, close } = await networkFixture((_req, res) => { calls++; res.writeHead(200); res.write('{"results":['); }, { deadlineMs: 100, timeoutMs: 1000 });
  try { await assert.rejects(pool.request('/search', {}), { code: 'TIMEOUT' }); assert.equal(calls, 1); assert.equal(pool.active, 0); }
  finally { await close(); }
});

test('native fetch: 429 rotates with correct header and payload', { timeout: 3000 }, async () => {
  const keys = [], bodies = [];
  const { pool, close } = await networkFixture(async (req, res) => {
    keys.push(req.headers['x-api-key']); let body = ''; for await (const chunk of req) body += chunk; bodies.push(JSON.parse(body));
    if (keys.length === 1) { res.writeHead(429, { 'retry-after': '120' }); res.end('limited'); }
    else { res.setHeader('content-type', 'application/json'); res.end('{"results":[]}'); }
  });
  try { await pool.request('/search', { query: 'a' }); assert.deepEqual(keys, ['secret-one', 'secret-two']); assert.deepEqual(bodies, [{ query: 'a' }, { query: 'a' }]); }
  finally { await close(); }
});

test('MCP cancellation notification aborts actual HTTP request', { timeout: 3000 }, async () => {
  const started = deferred(), disconnected = deferred();
  const { pool, close } = await networkFixture((_req, res) => {
    res.on('close', disconnected.resolve); res.writeHead(200); res.write('{'); started.resolve();
  });
  const server = createServer(pool), client = new Client({ name: 'cancel-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try {
    const controller = new AbortController();
    const pending = client.callTool({ name: 'exa_search', arguments: { query: 'test' } }, undefined, { signal: controller.signal }).catch(e => e);
    await started.promise; controller.abort(); await pending;
    await disconnected.promise;
    assert.equal(pool.active, 0);
    assert.equal(pool.status().keys[0].state, 'ready');
  } finally { await client.close(); await server.close(); await close(); }
});


test('HTTP-date Retry-After uses wall clock while cooldown uses monotonic clock', async () => {
  let clock = 1000, wall = Date.parse('2026-10-28T00:00:00Z'), calls = 0;
  const pool = new KeyPool(config(), { now: () => clock, wallNow: () => wall, fetchImpl: async () => ++calls === 1 ? new Response('limited', { status: 429, headers: { 'retry-after': 'Wed, 28 Oct 2026 00:02:00 GMT' } }) : ok() });
  await pool.request('/search', {});
  assert.equal(pool.status().keys[0].retryAfterSeconds, 120);
  wall += 86400000; clock += 1000;
  assert.equal(pool.status().keys[0].retryAfterSeconds, 119);
});

test('native connection reset retries only once and releases all reservations', { timeout: 3000 }, async () => {
  let calls = 0;
  const { pool, close } = await networkFixture((req) => { calls++; req.socket.destroy(); });
  try {
    await assert.rejects(pool.request('/search', {}), { code: 'NETWORK_ERROR' });
    assert.equal(calls, 2); assert.equal(pool.active, 0);
    assert.ok(pool.status().keys.every(k => k.inflight === 0));
  } finally { await close(); }
});

test('300 calls in bounded parallel batches leave no key or concurrency reservations', async () => {
  const pool = new KeyPool(config(), { fetchImpl: async () => ok() });
  for (let i = 0; i < 100; i++) await Promise.all([pool.request('/search', {}), pool.request('/search', {}), pool.request('/contents', {})]);
  assert.equal(pool.active, 0);
  assert.ok(pool.status().keys.every(k => k.inflight === 0 && k.successes === 100));
});

test('HTTP 200 contents with no readable pages is a tool error, empty search is not', async () => {
  const pool = new KeyPool(config(), { fetchImpl: async () => new Response(JSON.stringify({ results: [], statuses: [{ id: 'https://example.com', status: 'error', error: { tag: 'CRAWL_ERROR' } }] })) });
  const server = createServer(pool), client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try {
    const contents = await client.callTool({ name: 'exa_fetch', arguments: { urls: ['https://example.com'] } });
    assert.equal(contents.isError, true);
    assert.equal(JSON.parse(contents.content[0].text).error.code, 'CONTENT_UNAVAILABLE');
    const search = await client.callTool({ name: 'exa_search', arguments: { query: 'test' } });
    assert.ok(!search.isError);
  } finally { await client.close(); await server.close(); }
});

test('stdio rejects oversized input and exits without raw data in stderr', { timeout: 3000 }, async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', "await import('./src/index.js'); process.stderr.write('ready\\n');"], { env: { ...process.env, EXA_API_KEYS: '["fake-key"]', EXA_KEYS_FILE: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  try {
    await once(child.stderr, 'data');
    let stderr = ''; child.stderr.on('data', x => { stderr += x; });
    const exited = once(child, 'exit');
    child.stdin.write('sensitive-value-'.repeat(20000));
    const result = await Promise.race([exited, sleep(800).then(() => 'hung')]);
    assert.notEqual(result, 'hung');
    assert.ok(!stderr.includes('sensitive-value'));
  } finally { child.kill('SIGKILL'); }
});
