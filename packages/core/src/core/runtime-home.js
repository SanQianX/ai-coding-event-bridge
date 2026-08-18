'use strict';

const fs = require('fs');
const path = require('path');
const { bridgeHome } = require('./paths');
const { CrossProcessLock, lockPathFor } = require('./lock');
const { writeJsonAtomicSync, readJsonIfExists, ensureDirSync } = require('./fs-utils');
const semver = require('./semver');

const SHIM_PATH_PARTS = ['bin', 'bridge-hook.cjs'];

// The shim is intentionally version-independent: AI client configs point at this
// stable path forever, and it delegates to whatever runtime version is active.
const SHIM_SOURCE = `#!/usr/bin/env node
'use strict';
// Stable per-user Bridge hook shim. Managed AI client entries always point here,
// never into any host's node_modules. Fail-open: a broken Bridge must never
// block the AI client itself.
const fs = require('fs');
const path = require('path');
const os = require('os');

function home() {
  return process.env.AI_CODING_EVENT_BRIDGE_HOME || path.join(os.homedir(), '.ai-coding-event-bridge');
}

async function main() {
  const active = JSON.parse(fs.readFileSync(path.join(home(), 'active-runtime.json'), 'utf8'));
  const hookPath = path.join(home(), 'runtime', String(active.version), 'hook.cjs');
  if (!fs.existsSync(hookPath)) return;
  const runtime = require(hookPath);
  if (typeof runtime.main === 'function') {
    await runtime.main({ argv: process.argv.slice(2), env: process.env, home: home() });
  }
}

main().catch(() => {
  // Fail open by design. Diagnostics belong to the runtime's own journal, not stderr noise.
});
`;

const RUNTIME_HOOK_SOURCE = `#!/usr/bin/env node
'use strict';
// Runtime hook implementation for this Bridge version. Connectors attach here
// in later commits; the default implementation is a durable no-op that always
// exits 0 so AI clients are never blocked.
async function main() {
  return { status: 'no-op' };
}

module.exports = { main };
`;

async function ensureRuntimeHome({ homeDir, version } = {}) {
  const home = bridgeHome(homeDir);
  const requestedVersion = version || require('../../package.json').version;
  const lock = new CrossProcessLock(lockPathFor(home, 'install.lock'));
  return lock.withLock(async () => {
    ensureDirSync(path.join(home, 'bin'));
    ensureDirSync(path.join(home, 'runtime'));
    ensureDirSync(path.join(home, 'journal'));
    ensureDirSync(path.join(home, 'locks'));

    const shimPath = path.join(home, ...SHIM_PATH_PARTS);
    const tmpShim = `${shimPath}.tmp`;
    const fd = fs.openSync(tmpShim, 'w');
    try {
      fs.writeSync(fd, SHIM_SOURCE);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpShim, shimPath);

    const runtimeDir = path.join(home, 'runtime', requestedVersion);
    const activeFile = path.join(home, 'active-runtime.json');
    const active = readJsonIfExists(activeFile);

    const materializeRuntime = () => {
      ensureDirSync(runtimeDir);
      const hookPath = path.join(runtimeDir, 'hook.cjs');
      if (!fs.existsSync(hookPath)) {
        const tmp = `${hookPath}.tmp`;
        const hfd = fs.openSync(tmp, 'w');
        try {
          fs.writeSync(hfd, RUNTIME_HOOK_SOURCE);
          fs.fsyncSync(hfd);
        } finally {
          fs.closeSync(hfd);
        }
        fs.renameSync(tmp, hookPath);
      }
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
