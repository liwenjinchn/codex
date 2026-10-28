#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { KeyPool } from './pool.js';
import { createServer } from './server.js';

try {
  const server = createServer(new KeyPool(loadConfig()));
  let closing = false;
  const close = async (code = 0) => {
    if (closing) return;
    closing = true;
    try { await server.close(); }
    catch { code = 1; }
    finally { process.exit(code); }
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  process.stdin.once('end', () => void close());
  process.stdin.once('close', () => void close());
  process.stdin.once('error', () => void close(1));
  process.stdout.once('error', () => void close(1));
  server.server.onclose = () => void close();
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 256 * 1024 }));
} catch {
  // stdout is reserved for MCP; never dump configuration or raw errors.
  process.stderr.write('exa-keypool: startup failed. Check Node >=22, dependencies and private key configuration; see README.\n');
  process.exitCode = 1;
}
