'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  installZcodeHook,
  statusZcodeHook,
  uninstallZcodeHook,
  HOOK_EVENTS,
  isManagedHook,
  managedHook
} = require('../src/bridge/installers/zcode/installer');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-zcode-installer-'));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main() {
  const configFile = path.join(HOME, 'fake-zcode', 'cli', 'config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });

  // Pre-existing user config with an unrelated top-level section and a
  // third-party hook group: both must survive every install/uninstall.
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      plugins: { enabledPlugins: { 'github@zcode-plugins-official': true } },
      hooks: {
        events: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo third-party' }] }]
        }
      }
    }, null, 2),
    'utf8'
  );

  // --- install: adds managed entries, forces the runner on, keeps the rest ---
  const installed = await installZcodeHook({ homeDir: HOME, configFile });
  assert.deepStrictEqual(installed.added.sort(), [...HOOK_EVENTS].sort());
  let config = readJson(configFile);
  assert.deepStrictEqual(config.plugins.enabledPlugins, { 'github@zcode-plugins-official': true }, 'unrelated config keys preserved');
  assert.strictEqual(config.hooks.enabled, true, 'configuration-file hooks runner enabled');
  assert.strictEqual(config.hooks.events.UserPromptSubmit.length, 2, 'third-party group kept, managed group appended');
  const managed = config.hooks.events.UserPromptSubmit[1];
  assert.strictEqual(managed.hooks[0].type, 'process');
  assert.strictEqual(managed.hooks[0].command, 'node');
  assert.strictEqual(managed.hooks[0].args[0], path.join(HOME, 'bin', 'bridge-hook.cjs'));

  // --- status ---
  const status = await statusZcodeHook({ homeDir: HOME, configFile });
  assert.strictEqual(status.installed, true);
  assert.deepStrictEqual(status.managedEvents.sort(), [...HOOK_EVENTS].sort());
  assert.strictEqual(status.thirdPartyCount, 1);

  // --- idempotent reinstall ---
  const again = await installZcodeHook({ homeDir: HOME, configFile });
  assert.deepStrictEqual(again.added, [], 'reinstall adds nothing');
  assert.strictEqual(readJson(configFile).hooks.events.UserPromptSubmit.length, 2);

  // --- managed hook recognition helpers ---
  assert.ok(isManagedHook(managedHook(path.join(HOME, 'bin', 'bridge-hook.cjs')), path.join(HOME, 'bin', 'bridge-hook.cjs')));
  assert.ok(!isManagedHook({ type: 'process', command: 'node', args: ['other.cjs'] }, path.join(HOME, 'bin', 'bridge-hook.cjs')));

  // --- uninstall: removes only managed groups, leaves enabled + third-party ---
  const removed = await uninstallZcodeHook({ homeDir: HOME, configFile });
  assert.deepStrictEqual(removed.removedEvents.sort(), [...HOOK_EVENTS].sort());
  config = readJson(configFile);
  assert.deepStrictEqual(config.plugins.enabledPlugins, { 'github@zcode-plugins-official': true });
  assert.strictEqual(config.hooks.enabled, true, 'enabled flag left for potential third-party config hooks');
  assert.strictEqual(config.hooks.events.UserPromptSubmit.length, 1, 'third-party group survives');
  assert.strictEqual(config.hooks.events.UserPromptSubmit[0].hooks[0].command, 'echo third-party');
  assert.strictEqual(config.hooks.events.Stop, undefined, 'emptied event key removed');

  const statusAfter = await statusZcodeHook({ homeDir: HOME, configFile });
  assert.strictEqual(statusAfter.installed, false);

  // --- missing config file: install creates one from scratch ---
  const freshConfig = path.join(HOME, 'fresh-zcode', 'cli', 'config.json');
  fs.mkdirSync(path.dirname(freshConfig), { recursive: true });
  await installZcodeHook({ homeDir: HOME, configFile: freshConfig });
  config = readJson(freshConfig);
  assert.strictEqual(config.hooks.enabled, true);
  assert.deepStrictEqual(Object.keys(config.hooks.events).sort(), [...HOOK_EVENTS].sort());

  console.log('zcode-installer-test: ok');
}

module.exports = main();
