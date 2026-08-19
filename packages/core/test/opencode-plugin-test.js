'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { ensureRuntimeHome } = require('../src/core/runtime-home');
const { Journal } = require('../src/core/journal');
const { repoIdentityKey } = require('../src/core/repo-context');
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
  assert.deepStrictEqual(open.map(t => t.turnId), ['oc-t2'], 'turn with a reply is closed; the unanswered offline prompt stays open');

  // Canonical turn identity without client turnIds, per-session and per-repo.
  const repoX = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-oc-x-'));
  const repoY = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-oc-y-'));
  for (const dir of [repoX, repoY]) {
    await new Promise((resolve, reject) => execFile('git', ['init', '-q'], { cwd: dir, windowsHide: true }, (e) => (e ? reject(e) : resolve())));
  }
  const sessA = { type: 'user', sessionId: 'oc-no-turn-a', cwd: repoX, text: 'prompt A in repo X' };
  const sessB = { type: 'user', sessionId: 'oc-no-turn-b', cwd: repoY, text: 'prompt B in repo Y' };
  const userA = await hookEntry.main({ home: HOME, payload: sessA });
  const userB = await hookEntry.main({ home: HOME, payload: sessB });
  const replyA = await hookEntry.main({ home: HOME, payload: { type: 'assistant', sessionId: 'oc-no-turn-a', cwd: repoX, text: 'reply A' } });
  const replyB = await hookEntry.main({ home: HOME, payload: { type: 'assistant', sessionId: 'oc-no-turn-b', cwd: repoY, text: 'reply B' } });
  assert.match(userA.turnId, /^turn_[0-9a-f-]{36}$/, 'Bridge mints the user turnId when the client supplied none');
  assert.strictEqual(replyA.turnId, userA.turnId, 'assistant binds to its session turn');
  assert.strictEqual(replyB.turnId, userB.turnId);
  assert.notStrictEqual(userA.turnId, userB.turnId, 'two sessions never share a turn');
  const turnEvents = await journal.readEvents({});
  const eventA = turnEvents.find((e) => e.sequence === userA.sequence);
  const eventB = turnEvents.find((e) => e.sequence === userB.sequence);
  assert.notStrictEqual(
    repoIdentityKey(eventA.repoIdentity),
    repoIdentityKey(eventB.repoIdentity),
    'two repos never cross-bind'
  );

  // Capture-disable writes nothing.
  const beforeDisable = (await journal.readEvents({})).length;
  const previousCapture = process.env.AI_CODING_EVENT_BRIDGE_CAPTURE;
  process.env.AI_CODING_EVENT_BRIDGE_CAPTURE = '0';
  try {
    const disabled = await hookEntry.main({ home: HOME, payload: { type: 'user', sessionId: 'oc-internal', cwd: repoX, text: 'internal' } });
    assert.deepStrictEqual(disabled, { status: 'ignored', reason: 'capture-disabled' });
    assert.strictEqual((await journal.readEvents({})).length, beforeDisable, 'capture-disabled writes zero journal records');
  } finally {
    if (previousCapture === undefined) delete process.env.AI_CODING_EVENT_BRIDGE_CAPTURE;
    else process.env.AI_CODING_EVENT_BRIDGE_CAPTURE = previousCapture;
  }

  // Installer: managed plugin file, third-party files preserved on uninstall.
  const pluginsDir = path.join(HOME, 'opencode-plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'my-own-plugin.js'), '// third party\n');
  await installOpenCodePlugin({ homeDir: HOME, consumerName: 'project-knowledge', registerConsumer: true, pluginsDir, version: '0.1.0' });
  const status = await statusOpenCodePlugin({ homeDir: HOME, pluginsDir });
  assert.strictEqual(status.installed, true);
  assert.strictEqual(status.thirdPartyFiles, 1);
  assert(fs.readFileSync(path.join(pluginsDir, PLUGIN_FILE_NAME), 'utf8').includes('bridge-hook.cjs'));

  // Disable OpenCode capture only: plugin removed, host consumer KEPT.
  const disableCapture = await uninstallOpenCodePlugin({ homeDir: HOME, pluginsDir });
  assert.strictEqual(disableCapture.removed, true);
  assert.deepStrictEqual(disableCapture.consumers, ['project-knowledge']);
  assert(!fs.existsSync(path.join(pluginsDir, PLUGIN_FILE_NAME)), 'managed plugin removed');
  assert(fs.existsSync(path.join(pluginsDir, 'my-own-plugin.js')), 'third-party plugin preserved');

  // Host global disable: explicit consumer unregister after cleanup.
  await installOpenCodePlugin({ homeDir: HOME, pluginsDir, version: '0.1.0' });
  const final = await uninstallOpenCodePlugin({ homeDir: HOME, consumerName: 'project-knowledge', unregisterConsumer: true, pluginsDir });
  assert.strictEqual(final.removed, true);
  assert.strictEqual(final.consumerUnregistered, true);
  assert.deepStrictEqual(final.consumers, []);
  assert(fs.existsSync(path.join(HOME, 'bin', 'bridge-hook.cjs')), 'shared runtime home preserved');

  console.log('opencode-plugin-test PASS');
}

module.exports = main();
