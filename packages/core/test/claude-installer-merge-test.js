'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  installClaudeCodeHook,
  statusClaudeCodeHook,
  repairClaudeCodeHook,
  uninstallClaudeCodeHook,
  managedCommand
} = require('../src/installers/claude-code/installer');
const { InstallerError } = require('../src/installers/claude-code/installer');

// The home path deliberately contains a space to prove Windows-style command
// quoting survives the managed entry round-trip.
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge claude installer-'));
const HOME = path.join(BASE, 'bridge home with spaces');
const SETTINGS = path.join(BASE, 'claude settings with spaces.json');

function readSettings() {
  return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
}

async function main() {
  // Third-party hook exists before Bridge ever touches the config.
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(
    SETTINGS,
    JSON.stringify(
      {
        model: 'sonnet',
        hooks: {
          Stop: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'node /somewhere/notify-user.js' }]
            }
          ]
        }
      },
      null,
      2
    )
  );

  const installed = await installClaudeCodeHook({
    homeDir: HOME,
    consumerName: 'project-knowledge',
    registerConsumer: true,
    settingsFile: SETTINGS,
    version: '0.1.0'
  });
  assert.deepStrictEqual(installed.added.sort(), ['Stop', 'UserPromptSubmit']);
  const settings = readSettings();
  const stopGroups = settings.hooks.Stop;
  assert.strictEqual(stopGroups.length, 2, 'managed entry added alongside the third-party group');
  const thirdParty = stopGroups.find((g) => g.hooks[0].command === 'node /somewhere/notify-user.js');
  assert.ok(thirdParty, 'third-party hook preserved verbatim');
  assert.strictEqual(settings.model, 'sonnet', 'unrelated settings preserved');

  const shimPath = path.join(HOME, 'bin', 'bridge-hook.cjs');
  const command = managedCommand(shimPath);
  assert.ok(command.includes(`"${shimPath}"`), 'quoted stable path handles spaces');
  assert.strictEqual(fs.existsSync(shimPath), true);

  const status = await statusClaudeCodeHook({ homeDir: HOME, settingsFile: SETTINGS });
  assert.strictEqual(status.installed, true);
  assert.strictEqual(status.thirdPartyCount, 1);
  assert.deepStrictEqual(status.consumers, ['project-knowledge']);

  // A second consumer installs without duplicating managed entries.
  await installClaudeCodeHook({
    homeDir: HOME,
    consumerName: 'devtask-radar',
    registerConsumer: true,
    settingsFile: SETTINGS,
    version: '0.1.0'
  });
  assert.strictEqual(readSettings().hooks.UserPromptSubmit.length, 1, 'no duplicate managed groups');
  assert.strictEqual(readSettings().hooks.Stop.length, 2);

  // Disable Claude capture only: managed hook removed, host consumer KEPT.
  const disableCapture = await uninstallClaudeCodeHook({ homeDir: HOME, settingsFile: SETTINGS });
  assert.strictEqual(disableCapture.removed, true);
  assert.deepStrictEqual(disableCapture.consumers.sort(), ['devtask-radar', 'project-knowledge']);
  const afterDisable = readSettings();
  assert.ok(!afterDisable.hooks.UserPromptSubmit, 'managed event removed entirely');
  assert.strictEqual(afterDisable.hooks.Stop.length, 1);
  assert.strictEqual(afterDisable.hooks.Stop[0].hooks[0].command, 'node /somewhere/notify-user.js');
  assert.strictEqual(afterDisable.model, 'sonnet');

  // Repair restores a deleted managed entry while the third-party group survives.
  await repairClaudeCodeHook({ homeDir: HOME, consumerName: 'project-knowledge', registerConsumer: true, settingsFile: SETTINGS, version: '0.1.0' });
  const repaired = await statusClaudeCodeHook({ homeDir: HOME, settingsFile: SETTINGS });
  assert.strictEqual(repaired.installed, true, 'repair restores all managed events');
  assert.strictEqual(repaired.thirdPartyCount, 1, 'third-party hook still intact after repair');

  // Host global disable: connector cleanup, then explicit consumer unregister.
  const final = await uninstallClaudeCodeHook({ homeDir: HOME, consumerName: 'project-knowledge', unregisterConsumer: true, settingsFile: SETTINGS });
  assert.strictEqual(final.removed, true);
  assert.strictEqual(final.consumerUnregistered, true);
  assert.deepStrictEqual(final.consumers, ['devtask-radar'], 'other consumers remain untouched');
  assert.strictEqual(fs.existsSync(shimPath), true, 'shared runtime home is never removed by connector uninstall');

  // Corrupt user config is never overwritten.
  const beforeRaw = fs.readFileSync(SETTINGS, 'utf8');
  fs.writeFileSync(SETTINGS, '{not json');
  let threw = false;
  try {
    await installClaudeCodeHook({ homeDir: HOME, settingsFile: SETTINGS, version: '0.1.0' });
  } catch (err) {
    threw = err instanceof InstallerError;
  }
  assert.ok(threw, 'corrupt settings must raise InstallerError');
  assert.strictEqual(fs.readFileSync(SETTINGS, 'utf8'), '{not json');

  console.log('claude-installer-merge-test PASS');
}

module.exports = main();
