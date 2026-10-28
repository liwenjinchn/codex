import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer, compact } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { KeyPool } from '../src/pool.js';

async function fixture() {
  const calls = [];
  const pool = new KeyPool(loadConfig({ EXA_API_KEYS: '["test-key-one"]' }), {
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ results: [{ title: 'Docs', url: 'https://example.com/docs', text: 'content' }] }));
    },
  });
  const server = createServer(pool);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  return { client, calls, close: async () => { await client.close(); await server.close(); } };
}

test('MCP initialize/list/search/fetch/status with official client', async () => {
  const { client, calls, close } = await fixture();
  try {
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['exa_search', 'exa_fetch', 'exa_pool_status']);
    const response = await client.callTool({ name: 'exa_search', arguments: { query: 'MCP docs', includeDomains: ['example.com'] } });
    assert.equal(JSON.parse(response.content[0].text).results[0].url, 'https://example.com/docs');
    assert.deepEqual(calls[0].body, { query: 'MCP docs', numResults: 5, type: 'auto', includeDomains: ['example.com'], contents: { text: { maxCharacters: 2400 } } });
    await client.callTool({ name: 'exa_fetch', arguments: { urls: ['https://example.com/docs'] } });
    assert.equal(calls[1].url, 'https://api.exa.ai/contents');
    assert.deepEqual(calls[1].body.urls, ['https://example.com/docs']);
    const status = await client.callTool({ name: 'exa_pool_status', arguments: {} });
    assert.equal(JSON.parse(status.content[0].text).keys[0].successes, 2);
    assert.equal(calls.length, 2);
  } finally { await close(); }
});

test('MCP rejects bad arguments before provider calls', async () => {
  const { client, calls, close } = await fixture();
  try {
    const cases = [
      ['exa_search', { query: '' }], ['exa_search', { query: 'a', numResults: 100 }],
      ['exa_search', { query: 'a', includeDomains: ['https://example.com'] }],
      ['exa_search', { query: 'a', startPublishedDate: '2026-02-02T00:00:00Z', endPublishedDate: '2026-01-01T00:00:00Z' }],
      ['exa_fetch', { urls: ['file:///etc/passwd'] }], ['exa_fetch', { urls: ['http://127.0.0.1/'] }],
      ['exa_fetch', { urls: ['https://user:pass@example.com'] }], ['exa_fetch', { urls: [] }],
    ];
    for (const [name, args] of cases) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, `${name} should fail`);
    }
    assert.equal(calls.length, 0);
  } finally { await close(); }
});

test('content budgeting preserves JSON/citations and de-duplicates URLs', () => {
  const output = compact({ results: [
    { url: 'https://example.com/a#one', title: 'A', text: 'a'.repeat(10000) },
    { url: 'https://example.com/a#two', title: 'A', text: 'duplicate' },
    { url: 'https://example.com/b', title: 'B', text: 'b'.repeat(10000) },
  ] }, 1000);
  assert.equal(output.results.length, 2);
  assert.ok(output.results.reduce((n, r) => n + r.content.length, 0) <= 1000);
  assert.equal(output.truncated, true);
  assert.equal(JSON.parse(JSON.stringify(output)).results[0].url, 'https://example.com/a');
});

test('key-file permissions, precedence, duplicate removal and invalid config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exa-test-')); const file = join(dir, 'keys.json');
  try {
    writeFileSync(file, '["one", "one", "two"]', { mode: 0o600 });
    assert.deepEqual(loadConfig({ EXA_KEYS_FILE: file, EXA_API_KEY: 'ignored' }).keys, ['one', 'two']);
    if (process.platform !== 'win32') { chmodSync(file, 0o644); assert.throws(() => loadConfig({ EXA_KEYS_FILE: file }), /chmod 600/); }
    assert.throws(() => loadConfig({}), /Configure/);
    assert.throws(() => loadConfig({ EXA_API_KEYS: 'not-json' }), /JSON array/);
    assert.throws(() => loadConfig({ EXA_API_KEY: 'one', EXA_MAX_CONCURRENT: 'NaN' }), /integer/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('real stdio subprocess handshake and health (no Exa network call)', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('src/index.js')], env: { EXA_API_KEYS: '["mock-stdio-key"]' }, stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 3);
    const status = await client.callTool({ name: 'exa_pool_status', arguments: {} });
    assert.equal(JSON.parse(status.content[0].text).keys[0].state, 'ready');
  } finally { await client.close(); }
});
