import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPool, retryDelay } from '../src/pool.js';
import { loadConfig } from '../src/config.js';

const config = extras => ({ ...loadConfig({ EXA_API_KEYS: '["secret-one","secret-two","secret-three"]' }), ...extras });
const ok = () => new Response(JSON.stringify({ results: [{ title: 'Docs', url: 'https://example.com', text: 'Body' }] }));
const fail = (status, headers = {}) => new Response('secret-one must never leak', { status, headers });
function fixture(responses, extra = {}) {
  const calls = []; let clock = 1000;
  const pool = new KeyPool(config(extra), { now: () => clock, fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(options) : next;
  } });
  return { pool, calls, advance: ms => { clock += ms; } };
}

test('priority retains primary on success', async () => {
  const { pool, calls } = fixture([ok(), ok()]);
  await pool.request('/search', { query: 'a' }); await pool.request('/search', { query: 'b' });
  assert.deepEqual(calls.map(c => c.headers['x-api-key']), ['secret-one', 'secret-one']);
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].url, 'https://api.exa.ai/search');
});

test('402 failover, cooldown, expiry and recovery', async () => {
  const { pool, calls, advance } = fixture([fail(402), ok(), ok(), ok()], { paymentCooldownMs: 1000 });
  await pool.request('/search', {}); await pool.request('/search', {});
  assert.deepEqual(calls.map(c => c.headers['x-api-key']), ['secret-one', 'secret-two', 'secret-two']);
  assert.equal(pool.status().keys[0].reason, 'payment_required');
  advance(1001); await pool.request('/search', {});
  assert.equal(calls[3].headers['x-api-key'], 'secret-one');
});

test('401 and 403 disable only the failed keys', async () => {
  const { pool, calls } = fixture([fail(401), fail(403), ok(), ok()]);
  await pool.request('/search', {}); await pool.request('/search', {});
  assert.equal(calls.length, 4);
  assert.deepEqual(pool.status().keys.map(k => k.state), ['disabled', 'disabled', 'ready']);
});

test('429 Retry-After is respected, even beyond default', async () => {
  const { pool, calls } = fixture([fail(429, { 'retry-after': '900' }), ok(), ok()]);
  await pool.request('/search', {}); await pool.request('/search', {});
  assert.equal(pool.status().keys[0].retryAfterSeconds, 900);
  assert.equal(calls[2].headers['x-api-key'], 'secret-two');
  assert.equal(retryDelay('Thu, 01 Jan 1970 00:02:00 GMT', 0, 1000), 120000);
  assert.equal(retryDelay('nonsense', 0, 60000), 60000);
});

test('all keys exhausted: bounded attempts and no busy-loop', async () => {
  const { pool, calls } = fixture([fail(402), fail(402), fail(402)]);
  await assert.rejects(pool.request('/search', {}), { code: 'NO_AVAILABLE_KEY' });
  await assert.rejects(pool.request('/search', {}), { code: 'NO_AVAILABLE_KEY' });
  assert.equal(calls.length, 3); assert.equal(pool.active, 0);
});

test('400 does not rotate and provider body is not echoed', async () => {
  const { pool, calls } = fixture([fail(400)]);
  await assert.rejects(pool.request('/search', {}), e => e.code === 'UPSTREAM_REJECTED' && !e.message.includes('secret'));
  assert.equal(calls.length, 1);
});

test('503 stops all-key stampede and respects service Retry-After', async () => {
  const { pool, calls } = fixture([fail(503, { 'retry-after': '120' })]);
  await assert.rejects(pool.request('/search', {}), { code: 'UPSTREAM_UNAVAILABLE' });
  await assert.rejects(pool.request('/search', {}), { code: 'SERVICE_COOLDOWN' });
  assert.equal(calls.length, 1); assert.equal(pool.status().serviceRetryAfterSeconds, 120);
});

test('round-robin visits each key', async () => {
  const { pool, calls } = fixture([ok(), ok(), ok(), ok()], { strategy: 'round-robin' });
  for (let i = 0; i < 4; i++) await pool.request('/search', {});
  assert.deepEqual(calls.map(c => c.headers['x-api-key']), ['secret-one', 'secret-two', 'secret-three', 'secret-one']);
});

test('network error retries at most once and never echoes raw error', async () => {
  const { pool, calls } = fixture([Object.assign(new Error('secret-one'), { code: 'ECONNRESET' }), Object.assign(new Error('secret-two'), { code: 'ECONNRESET' })]);
  await assert.rejects(pool.request('/search', {}), e => e.code === 'NETWORK_ERROR' && !e.message.includes('secret'));
  assert.equal(calls.length, 2);
});

test('concurrent requests reserve different keys; fourth is rejected', async () => {
  const release = [];
  const { pool, calls } = fixture([1, 2, 3].map(() => () => new Promise(resolve => release.push(() => resolve(ok())))));
  const pending = [pool.request('/search', {}), pool.request('/search', {}), pool.request('/search', {})];
  await assert.rejects(pool.request('/search', {}), { code: 'BUSY' });
  assert.equal(new Set(calls.map(c => c.headers['x-api-key'])).size, 3);
  release.forEach(fn => fn()); await Promise.all(pending);
  assert.equal(pool.active, 0); assert.ok(pool.status().keys.every(k => k.inflight === 0));
});

test('cancellation does not rotate or penalize key', async () => {
  const controller = new AbortController();
  const { pool, calls } = fixture([options => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))))]);
  const pending = pool.request('/search', {}, controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(calls.length, 1); assert.equal(pool.status().keys[0].state, 'ready');
});

test('deadline ends request and releases reservation', async () => {
  const { pool, calls } = fixture([options => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout'))))], { deadlineMs: 20, timeoutMs: 100 });
  const keepAlive = setTimeout(() => {}, 200);
  try { await assert.rejects(pool.request('/search', {}), { code: 'TIMEOUT' }); }
  finally { clearTimeout(keepAlive); }
  assert.equal(calls.length, 1); assert.equal(pool.active, 0);
});

test('invalid JSON/shape and oversized responses do not rotate', async () => {
  for (const response of [new Response('bad'), new Response('{}'), new Response('x'.repeat(2_000_001))]) {
    const { pool, calls } = fixture([response]);
    await assert.rejects(pool.request('/search', {}), e => ['INVALID_RESPONSE', 'RESPONSE_TOO_LARGE'].includes(e.code));
    assert.equal(calls.length, 1);
  }
});

test('status and redaction never expose secret values', () => {
  const { pool } = fixture([]);
  assert.ok(!JSON.stringify(pool.status()).includes('secret'));
  assert.equal(pool.redact('secret-one secret-two secret-three'), '[REDACTED] [REDACTED] [REDACTED]');
});
