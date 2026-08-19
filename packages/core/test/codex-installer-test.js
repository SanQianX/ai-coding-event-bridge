'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  installCodexNotify,
  statusCodexNotify,
  uninstallCodexNotify
} = require('../src/installers/codex/installer');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge codex installer-'));
const HOME = path.join(BASE, 'bridge home');
const CONFIG = path.join(BASE, 'codex config.toml');

async function main() {
  // Config with third-party notify is never displaced.
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, 'model = "gpt-5"\nnotify = ["python", "C:/tools/my-notify.py"]\n');
  const conflict = await installCodexNotify({ homeDir: HOME, configFile: CONFIG, version: '0.1.0' });
  assert.strictEqual(conflict.installed, false);
  assert.strictEqual(conflict.conflict, true);
  assert.strictEqual(conflict.reason, 'third-party-notify-present');
  assert(fs.readFileSync(CONFIG, 'utf8').includes('my-notify.py'), 'third-party notifier preserved');

  // Clean install adds the managed entry and preserves unrelated keys.
  fs.writeFileSync(CONFIG, 'model = "gpt-5"\n');
  const installed = await installCodexNotify({ homeDir: HOME, consumerName: 'project-knowledge', registerConsumer: true, configFile: CONFIG, version: '0.1.0' });
  assert.strictEqual(installed.installed, true);
  const toml = fs.readFileSync(CONFIG, 'utf8');
  assert(toml.includes('notify = ["node", "' + path.join(HOME, 'bin', 'bridge-hook.cjs') + '"]'));
  assert(toml.includes('model = "gpt-5"'));

  const status = await statusCodexNotify({ homeDir: HOME, configFile: CONFIG });
  assert.strictEqual(status.installed, true);
  assert.strictEqual(status.thirdParty, false);

  // Idempotent reinstall does not duplicate.
  await installCodexNotify({ homeDir: HOME, configFile: CONFIG, version: '0.1.0' });
  assert.strictEqual(fs.readFileSync(CONFIG, 'utf8').match(/notify\s*=/g).length, 1);

  // Disable Codex capture only: managed entry removed, consumers untouched.
  await installCodexNotify({ homeDir: HOME, consumerName: 'devtask-radar', registerConsumer: true, configFile: CONFIG, version: '0.1.0' });
  const partial = await uninstallCodexNotify({ homeDir: HOME, configFile: CONFIG });
  assert.strictEqual(partial.removed, true);
  assert.deepStrictEqual(partial.consumers.sort(), ['devtask-radar', 'project-knowledge']);
  assert(!/notify\s*=/.test(fs.readFileSync(CONFIG, 'utf8')), 'managed notify removed on connector disable');

  // Host global disable: connector cleanup plus explicit consumer unregister.
  const final = await uninstallCodexNotify({ homeDir: HOME, consumerName: 'project-knowledge', unregisterConsumer: true, configFile: CONFIG });
  assert.strictEqual(final.removed, true);
  assert.strictEqual(final.consumerUnregistered, true);
  assert.deepStrictEqual(final.consumers, ['devtask-radar']);
  assert(fs.existsSync(path.join(HOME, 'bin', 'bridge-hook.cjs')), 'shared runtime home preserved');
  const after = fs.readFileSync(CONFIG, 'utf8');
  assert(!/notify\s*=/.test(after), 'managed notify removed');
  assert(after.includes('model = "gpt-5"'), 'unrelated keys preserved');

  console.log('codex-installer-test PASS');
}

module.exports = main();
