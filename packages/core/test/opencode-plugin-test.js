'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ensureRuntimeHome } = require('../src/core/runtime-home');
const { Journal } = require('../src/core/journal');
const hookEntry = require('../src/connectors/opencode/hook-entry');
const {
  installOpenCodePlugin,
  statusOpenCodePlugin,
  uninstallOpenCodePlugin,
  PLUGIN_FILE_NAME
} = require('../src/installers/opencode/installer');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-opencode-'));

function runShim(home, payloadJson) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(home, 'bin', 'bridge-hook.cjs')], {
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, AI_CODING_EVENT_BRIDGE_HOME: home }
    });
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code));
    child.stdin.write(payloadJson);
    child.stdin.end();
  });
}

async function main() {
  await ensureRuntimeHome({ homeDir: HOME, version: '0.1.0' });

  // User/assistant fixtures capture durably with repo context.
  const user = await hookEntry.main({
    home: HOME,
    payload: { type: 'user', sessionId: 'oc-s1', turnId: 'oc-t1', cwd: HOME, text: 'Refactor the API layer' }
  });
  assert.strictEqual(user.status, 'captured');
  const assistant = await hookEntry.main({
    home: HOME,
    payload: { type: 'assistant', sessionId: 'oc-s1', turnId: 'oc-t1', cwd: HOME, text: 'Refactored controllers.' }
  });
  assert.strictEqual(assistant.status, 'captured');

  // Tool events are optional diagnostics and never enter the conversation truth.
  const tool = await hookEntry.main({ home: HOME, payload: { type: 'tool', sessionId: 'oc-s1', name: 'bash' } });
  assert.strictEqual(tool.status, 'ignored');

  // Offline durable append: the shim works with no HTTP server running at all.
  const code = await runShim(HOME, JSON.stringify({ type: 'user', sessionId: 'oc-s2', turnId: 'oc-t2', cwd: HOME, text: 'offline durable append' }));
  assert.strictEqual(code, 0);

  const journal = new Journal(path.join(HOME, 'journal'));
  const events = await journal.readEvents({});
  assert.strictEqual(events.length, 3);
  assert(events.every(e => e.source === 'opencode'));
  assert.ok(events.some(e => e.content === 'offline durable append'));
  assert.ok(!events.some(e => e.eventType !== 'user_prompt' && e.eventType !== 'assistant_response'));
  assert.ok(!JSON.stringify(events).includes('8787'), 'no legacy HTTP endpoint coupling');
  const open = await journal.getOpenTurns();
  assert.deepStrictEqual(open.map(t => t.turnId), [], 'assistant closed its turn');

  // Installer: managed plugin file, third-party files preserved on uninstall.
  const pluginsDir = path.join(HOME, 'opencode-plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'my-own-plugin.js'), '// third party\n');
  await installOpenCodePlugin({ homeDir: HOME, consumerName: 'project-knowledge', pluginsDir, version: '0.1.0' });
  const status = await statusOpenCodePlugin({ homeDir: HOME, pluginsDir });
  assert.strictEqual(status.installed, true);
  assert.strictEqual(status.thirdPartyFiles, 1);
  assert(fs.readFileSync(path.join(pluginsDir, PLUGIN_FILE_NAME), 'utf8').includes('bridge-hook.cjs'));

  const partial = await uninstallOpenCodePlugin({ homeDir: HOME, consumerName: 'nonexistent-other', pluginsDir });
  assert.strictEqual(partial.removed, false, 'a remaining consumer keeps the plugin');
  const final = await uninstallOpenCodePlugin({ homeDir: HOME, consumerName: 'project-knowledge', pluginsDir });
  assert.strictEqual(final.removed, true);
  assert(!fs.existsSync(path.join(pluginsDir, PLUGIN_FILE_NAME)), 'managed plugin removed');
  assert(fs.existsSync(path.join(pluginsDir, 'my-own-plugin.js')), 'third-party plugin preserved');

  console.log('opencode-plugin-test PASS');
}

module.exports = main();
