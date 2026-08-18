'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureRuntimeHome } = require('../src/core/runtime-home');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-runtime-home-'));

async function main() {
  const first = await ensureRuntimeHome({ homeDir: HOME, version: '0.2.0' });
  assert.strictEqual(first.action, 'activated');
  assert.strictEqual(first.conflict, false);
  assert.strictEqual(fs.existsSync(path.join(HOME, 'bin', 'bridge-hook.cjs')), true, 'stable shim must exist');
  assert.strictEqual(fs.existsSync(path.join(HOME, 'runtime', '0.2.0', 'hook.cjs')), true);
  const shim = fs.readFileSync(path.join(HOME, 'bin', 'bridge-hook.cjs'), 'utf8');
  assert.ok(shim.includes('active-runtime.json'), 'shim delegates through active-runtime.json');
  assert.ok(!/[\\/]+node_modules[\\/]+/.test(shim), 'shim must never point into host node_modules');

  const again = await ensureRuntimeHome({ homeDir: HOME, version: '0.2.0' });
  assert.strictEqual(again.action, 'noop-same-version');

  const downgrade = await ensureRuntimeHome({ homeDir: HOME, version: '0.1.0' });
  assert.strictEqual(downgrade.action, 'kept-newer', 'automatic downgrade is forbidden');
  assert.strictEqual(downgrade.activeVersion, '0.2.0');

  const conflict = await ensureRuntimeHome({ homeDir: HOME, version: '1.0.0' });
  assert.strictEqual(conflict.conflict, true, 'major mismatch must be reported');
  assert.strictEqual(conflict.action, 'conflict-major-mismatch');
  assert.strictEqual(conflict.activeVersion, '0.2.0', 'conflict must not touch the active runtime');
  assert.strictEqual(fs.existsSync(path.join(HOME, 'runtime', '1.0.0')), false, 'conflicting runtime is not materialized');

  const upgrade = await ensureRuntimeHome({ homeDir: HOME, version: '0.3.0' });
  assert.strictEqual(upgrade.action, 'upgraded');
  assert.strictEqual(upgrade.activeVersion, '0.3.0');

  // Parallel installs serialize under the install lock and never corrupt state.
  const [a, b] = await Promise.all([
    ensureRuntimeHome({ homeDir: HOME, version: '0.4.0' }),
    ensureRuntimeHome({ homeDir: HOME, version: '0.4.0' })
  ]);
  assert.ok(['upgraded', 'noop-same-version'].includes(a.action));
  assert.ok(['upgraded', 'noop-same-version'].includes(b.action));
  assert.strictEqual(a.activeVersion, '0.4.0');
  assert.strictEqual(b.activeVersion, '0.4.0');
  JSON.parse(fs.readFileSync(path.join(HOME, 'active-runtime.json'), 'utf8'));

  // The shim still lives at the exact same stable path after upgrades.
  assert.strictEqual(fs.existsSync(path.join(HOME, 'bin', 'bridge-hook.cjs')), true);

  console.log('runtime-home-test PASS');
}

module.exports = main();
