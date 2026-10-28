#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { KeyPool } from './pool.js';
import { createServer } from './server.js';

try {
  const server = createServer(new KeyPool(loadConfig()));
  await server.connect(new StdioServerTransport());
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
} catch {
  // stdout is reserved for MCP; never dump configuration or raw errors.
  process.stderr.write('exa-keypool: startup failed. Check Node >=22, dependencies and private key configuration; see README.\n');
  process.exitCode = 1;
}
