'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ensureRuntimeHome } = require('../src/core/runtime-home');
const { ConsumerRegistry } = require('../src/core/consumer-registry');
const { Journal } = require('../src/core/journal');
const hookEntry = require('../src/connectors/claude-code/hook-entry');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-claude-connector-'));

function startNotifyServer() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(204);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port })));
}

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
  const registry = new ConsumerRegistry(HOME);
  // Dead notify target: durable capture must succeed regardless.
  await registry.registerConsumer('project-knowledge', { notifyUrl: 'http://127.0.0.1:9/bridge' });

  const promptPayload = {
    hookName: 'UserPromptSubmit',
    session_id: 'sess-fixture-1',
    cwd: HOME,
    prompt: 'Fix the login retry loop'
  };
  const captured = await hookEntry.main({ home: HOME, payload: promptPayload });
  assert.strictEqual(captured.status, 'captured');

  const stopPayload = {
    hookName: 'Stop',
    session_id: 'sess-fixture-1',
    cwd: HOME,
    last_assistant_message: 'Fixed the retry loop in auth.js'
  };
  const stopResult = await hookEntry.mainFailOpen({ home: HOME, payload: stopPayload });
  assert.strictEqual(stopResult.status, 'captured');
  assert.strictEqual(stopResult.turnId, captured.turnId, 'user + Stop pair shares one durable turnId');

  const journal = new Journal(path.join(HOME, 'journal'));
  const events = await journal.readEvents({});
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].eventType, 'user_prompt');
  assert.strictEqual(events[0].content, 'Fix the login retry loop');
  assert.strictEqual(events[0].sessionId, 'sess-fixture-1');
  assert.strictEqual(events[1].eventType, 'assistant_response');
  assert.strictEqual(events[1].content, 'Fixed the retry loop in auth.js');
  const openTurns = await journal.getOpenTurns();
  assert.strictEqual(openTurns.length, 0, 'Stop closes the session prompt turn');

  // Fail-open: a broken payload must never throw.
  const broken = await hookEntry.mainFailOpen({ home: HOME, payload: { hookName: 'Nope' } });
  assert.strictEqual(broken.status, 'ignored');

  // Capture-disable: internal SDK sessions never touch the journal.
  const beforeDisabled = (await journal.readEvents({})).length;
  const previousCapture = process.env.AI_CODING_EVENT_BRIDGE_CAPTURE;
  process.env.AI_CODING_EVENT_BRIDGE_CAPTURE = '0';
  try {
    const disabled = await hookEntry.main({
      home: HOME,
      payload: { hookName: 'UserPromptSubmit', session_id: 'sess-internal', cwd: HOME, prompt: 'internal workbench prompt' }
    });
    assert.deepStrictEqual(disabled, { status: 'ignored', reason: 'capture-disabled' });
    assert.strictEqual(
      (await journal.readEvents({})).length,
      beforeDisabled,
      'capture-disabled session must not increment journal sequence'
    );
  } finally {
    if (previousCapture === undefined) delete process.env.AI_CODING_EVENT_BRIDGE_CAPTURE;
    else process.env.AI_CODING_EVENT_BRIDGE_CAPTURE = previousCapture;
  }

  // Invalid cwd: captured as unavailable, never guessed into a repo.
  const invalidCwd = await hookEntry.main({
    home: HOME,
    payload: { hookName: 'UserPromptSubmit', session_id: 'sess-nogit', cwd: path.join(HOME, 'not-a-repo', 'deeper'), prompt: 'outside git' }
  });
  assert.strictEqual(invalidCwd.status, 'captured');
  const noGitEvents = await journal.readEvents({});
  const noGitEvent = noGitEvents.find((e) => e.sessionId === 'sess-nogit');
  assert.ok(noGitEvent, 'non-git prompt is still durable evidence');
  assert.strictEqual(noGitEvent.repoIdentity, null, 'never guessed into a repo');
  assert.match(noGitEvent.turnId, /^turn_/, 'canonical durable turn id assigned even outside a repo');

  // Durable capture BEFORE notification: a live consumer is notified only
  // after the event is already readable from the journal.
  const { server, received, port } = await startNotifyServer();
  await registry.registerConsumer('devtask-radar', { notifyUrl: `http://127.0.0.1:${port}/notify` });
  const before = (await journal.readEvents({})).length;
  const captured2 = await hookEntry.main({ home: HOME, payload: { ...promptPayload, session_id: 'sess-2', prompt: 'second' } });
  assert.strictEqual(captured2.status, 'captured');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(received.some((n) => n.sequence === captured2.sequence), 'notify fires for the new event');
  assert.strictEqual((await journal.readEvents({})).length, before + 1, 'journal grew before notify resolved');
  server.close();

  // End-to-end stable shim: real process, stdin payload, exit code 0 (fail-open).
  const code = await runShim(HOME, JSON.stringify({ hookName: 'UserPromptSubmit', session_id: 'sess-3', cwd: HOME, prompt: 'via shim' }));
  assert.strictEqual(code, 0, 'shim must always exit 0');
  const afterShim = await new Journal(path.join(HOME, 'journal')).readEvents({});
  assert.ok(afterShim.some((e) => e.content === 'via shim'), 'shim runtime captured the event durably');

  // The shim works even with a broken active runtime (fail-open, no block).
  fs.writeFileSync(path.join(HOME, 'active-runtime.json'), JSON.stringify({ version: '99.0.0' }));
  const codeBroken = await runShim(HOME, JSON.stringify({ hookName: 'UserPromptSubmit', prompt: 'x' }));
  assert.strictEqual(codeBroken, 0, 'broken runtime must still fail open');

  console.log('claude-connector-fixture-test PASS');
}

module.exports = main();
