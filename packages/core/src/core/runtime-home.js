'use strict';

const fs = require('fs');
const path = require('path');
const { bridgeHome } = require('./paths');
const { CrossProcessLock, lockPathFor } = require('./lock');
const { writeJsonAtomicSync, readJsonIfExists, ensureDirSync, copyDirSync } = require('./fs-utils');
const semver = require('./semver');

// The shim is intentionally version-independent: AI client configs point at this
// stable path forever, and it delegates to whatever runtime version is active.
// It reads the client payload from stdin, forwards it to the active runtime and
// always exits 0 — fail-open is a product invariant.
const SHIM_SOURCE = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function home() {
  return process.env.AI_CODING_EVENT_BRIDGE_HOME || path.join(os.homedir(), '.ai-coding-event-bridge');
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => (data += chunk));
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', () => resolve(data));
    } catch (_) {
      resolve(data);
    }
  });
}

(async () => {
  try {
    const raw = await readStdin();
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      payload = null;
    }
    const active = JSON.parse(fs.readFileSync(path.join(home(), 'active-runtime.json'), 'utf8'));
    const hookPath = path.join(home(), 'runtime', String(active.version), 'hook.cjs');
    if (fs.existsSync(hookPath)) {
      const runtime = require(hookPath);
      if (typeof runtime.main === 'function') {
        await runtime.main({ payload, home: home(), argv: process.argv.slice(2), env: process.env });
      }
    }
  } catch (_) {
    // Fail open by design: a broken Bridge must never block the AI client.
  } finally {
    process.exit(0);
  }
})();
`;

// The versioned runtime entry: dispatches the client payload into the
// self-contained bridge tree materialized next to it. The capture-disable
// environment marker is honored before any connector is even loaded.
const RUNTIME_HOOK_SOURCE = `#!/usr/bin/env node
'use strict';
async function main({ payload, home, argv, env }) {
  const effectiveEnv = env || process.env;
  if (effectiveEnv && effectiveEnv.AI_CODING_EVENT_BRIDGE_CAPTURE === '0') {
    return { status: 'ignored', reason: 'capture-disabled' };
  }
  if (payload && typeof payload === 'object') {
    // Claude Code ships hook_event_name (also seen as hookName/hook_name);
    // all three identify a Claude hook payload and MUST route to the Claude
    // connector — never fall through to Codex just because session_id exists.
    if (payload.hookName || payload.hook_event_name || payload.hook_name) {
      const claudeEntry = require('./bridge/connectors/claude-code/hook-entry.js');
      return claudeEntry.mainFailOpen({ home, payload, argv, env });
    }
    if (payload.type === 'user' || payload.type === 'assistant') {
      const opencodeEntry = require('./bridge/connectors/opencode/hook-entry.js');
      return opencodeEntry.mainFailOpen({ home, payload });
    }
    if (payload.session_id || payload.sessionId) {
      const codexEntry = require('./bridge/connectors/codex/hook-entry.js');
      return codexEntry.mainFailOpen({ home, payload });
    }
  }
  return { status: 'ignored' };
}
module.exports = { main };
`;

function materializeBridgeTree(runtimeDir) {
  const srcRoot = path.join(__dirname, '..');
  copyDirSync(path.join(srcRoot, 'core'), path.join(runtimeDir, 'bridge', 'core'));
  copyDirSync(path.join(srcRoot, 'connectors'), path.join(runtimeDir, 'bridge', 'connectors'));
}

function writeTextAtomicSync(file, content) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

async function ensureRuntimeHome({ homeDir, version } = {}) {
  const home = bridgeHome(homeDir);
  const requestedVersion = version || require('../../package.json').version;
  const lock = new CrossProcessLock(lockPathFor(home, 'install.lock'));
  return lock.withLock(async () => {
    ensureDirSync(path.join(home, 'bin'));
    ensureDirSync(path.join(home, 'runtime'));
    ensureDirSync(path.join(home, 'journal'));
    ensureDirSync(path.join(home, 'locks'));

    const shimPath = path.join(home, 'bin', 'bridge-hook.cjs');
    writeTextAtomicSync(shimPath, SHIM_SOURCE);

    const runtimeDir = path.join(home, 'runtime', requestedVersion);
    const activeFile = path.join(home, 'active-runtime.json');
    const active = readJsonIfExists(activeFile);

    const materializeRuntime = () => {
      ensureDirSync(runtimeDir);
      writeTextAtomicSync(path.join(runtimeDir, 'hook.cjs'), RUNTIME_HOOK_SOURCE);
      materializeBridgeTree(runtimeDir);
      if (!fs.existsSync(path.join(runtimeDir, 'manifest.json'))) {
        writeJsonAtomicSync(path.join(runtimeDir, 'manifest.json'), {
          version: requestedVersion,
          createdAt: new Date().toISOString()
        });
      }
    };

    let action;
    if (!active || !active.version) {
      materializeRuntime();
      writeJsonAtomicSync(activeFile, { version: requestedVersion, activatedAt: new Date().toISOString() });
      action = 'activated';
    } else {
      const cmp = semver.compare(active.version, requestedVersion);
      if (cmp === null) {
        materializeRuntime();
        writeJsonAtomicSync(activeFile, { version: requestedVersion, activatedAt: new Date().toISOString() });
        action = 'activated-unparseable-active';
      } else if (cmp === 0) {
        materializeRuntime();
        action = 'noop-same-version';
      } else if (cmp < 0) {
        const activeMajor = semver.parse(active.version).major;
        const requestedMajor = semver.parse(requestedVersion).major;
        if (activeMajor !== requestedMajor) {
          return {
            home,
            shimPath,
            conflict: true,
            activeVersion: active.version,
            requestedVersion,
            action: 'conflict-major-mismatch'
          };
        }
        materializeRuntime();
        writeJsonAtomicSync(activeFile, { version: requestedVersion, activatedAt: new Date().toISOString() });
        action = 'upgraded';
      } else {
        action = 'kept-newer';
      }
    }

    return {
      home,
      shimPath,
      conflict: false,
      activeVersion: readJsonIfExists(activeFile).version,
      requestedVersion,
      action
    };
  });
}

module.exports = { ensureRuntimeHome, SHIM_SOURCE };
