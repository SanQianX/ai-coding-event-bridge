#!/usr/bin/env node
'use strict';

const http = require('http');
const { bridgeHome } = require('@sanqianx/ai-coding-event-bridge');
const { createConsoleServer } = require('./server');

/**
 * ai-coding-event-bridge-console CLI
 *
 *   serve [--port 8790] [--host 127.0.0.1] [--home DIR]
 *         Start the local console (explorer page + JSON API).
 *
 * The server binds to localhost by default: journals contain full
 * conversation bodies, so they stay on this machine unless --host says
 * otherwise.
 */
async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const get = (name) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (command !== 'serve') {
    console.log('Usage: ai-coding-event-bridge-console serve [--port 8790] [--host 127.0.0.1] [--home DIR]');
    process.exitCode = command ? 1 : 0;
    return;
  }

  const home = bridgeHome(get('home'));
  const port = Number(get('port') || 8790);
  const host = get('host') || '127.0.0.1';
  const server = http.createServer(createConsoleServer({ home }));
  await new Promise((resolve) => server.listen(port, host, resolve));
  console.log(`ai-coding-event-bridge console serving on http://${host}:${port}`);
  console.log(`  home: ${home}`);
  console.log(`  import projects from the sidebar; conversations of imported`);
  console.log(`  projects are stored per-project under their chosen store.`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
