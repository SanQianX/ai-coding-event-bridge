#!/usr/bin/env node
'use strict';

/**
 * ai-coding-event-bridge CLI — named after the package itself (npm's default
 * bin rule: the command name is the package name, scope stripped).
 *
 *   ai-coding-event-bridge serve [--port 8790] [--host 127.0.0.1] [--home DIR]
 *       Start the local console. Delegates to
 *       @sanqianx/ai-coding-event-bridge-console when it is installed (same
 *       node_modules tree, or its global shim on PATH).
 *
 *   ai-coding-event-bridge commit-boundary [--cwd <repo>] [--home DIR]
 *                                          [--sha] [--branch]
 *                                          [--committed-at ISO] [--subject TEXT]
 *       Append one commit boundary event — the call a managed git post-commit
 *       hook makes.
 *
 * `bridge-commit-boundary` (src/bin/commit-boundary.js) remains published as a
 * compatibility alias: 0.4.0 hooks may already reference it.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONSOLE_PACKAGE = '@sanqianx/ai-coding-event-bridge-console';
const CONSOLE_COMMAND = 'ai-coding-event-bridge-console';

function usage() {
  console.log(`Usage: ai-coding-event-bridge <command> [options]

Commands:
  serve            Start the local console (explorer page + JSON API)
                     --port 8790  --host 127.0.0.1  --home DIR
  commit-boundary  Append one commit boundary event (git post-commit hooks)
                     --cwd <repo>  --home DIR  --sha  --branch
                     --committed-at ISO  --subject TEXT

The command name equals the package name (scope stripped). "serve" delegates
to ${CONSOLE_PACKAGE}; install it globally or next to this package. The older
"bridge-commit-boundary" command stays available as a commit-boundary alias.`);
}

function resolveConsoleEntry() {
  try {
    return require.resolve(`${CONSOLE_PACKAGE}/src/bin.js`);
  } catch (err) {
    return null;
  }
}

function consoleShimOnPath() {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, CONSOLE_COMMAND + ext))) return true;
      } catch (err) {
        // An unreadable PATH entry must not crash the lookup.
      }
    }
  }
  return false;
}

function serve(argv) {
  const consoleEntry = resolveConsoleEntry();
  if (consoleEntry) {
    // Same install tree (project dependency): run the console entry in-process.
    require(consoleEntry).main(['serve', ...argv]);
    return;
  }
  if (!consoleShimOnPath()) {
    console.error(`The console package is not installed. Start the console with:

  npm install -g ${CONSOLE_PACKAGE}
  ${CONSOLE_COMMAND} serve

or install it next to this package in a project:

  npm install ${CONSOLE_PACKAGE}
  npx ai-coding-event-bridge serve`);
    process.exitCode = 1;
    return;
  }
  // Global co-install: hand over to the console's npm shim and wait.
  const result = spawnSync(CONSOLE_COMMAND, ['serve', ...argv], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.error) {
    console.error(`failed to launch ${CONSOLE_COMMAND}: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status === null ? 1 : result.status;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);

  if (command === 'serve') {
    serve(rest);
  } else if (command === 'commit-boundary') {
    // commit-boundary.js reads its own flags from process.argv; the extra
    // "commit-boundary" positional is ignored by its --flag lookup. The
    // contract is one JSON line (ok:true/false) — keep it even when the
    // entry is required from this dispatcher rather than run directly.
    require('./commit-boundary').main().catch((err) => {
      process.stderr.write(`${JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) })}\n`);
      process.exitCode = 1;
    });
  } else {
    usage();
    process.exitCode = command ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
