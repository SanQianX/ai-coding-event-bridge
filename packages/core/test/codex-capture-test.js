'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { ensureRuntimeHome } = require('../src/core/runtime-home');
const { Journal } = require('../src/core/journal');
const { resolveRepoContext } = require('../src/core/repo-context');
const codex = require('../src/connectors/codex/hook-entry');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-codex-'));
const SESSIONS = path.join(HOME, 'fixtures', 'codex-sessions', '2026', '08', '18');

function sessionFile(id) {
  return path.join(SESSIONS, `rollout-2026-08-18-${id}.jsonl`);
}

function continuationFile(id, suffix, day = '19') {
  const dir = path.join(HOME, 'fixtures', 'codex-sessions', '2026', '08', day);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `rollout-2026-08-${day}T00-00-00-${id}_${suffix}.jsonl`);
}

function sessionMetaLine(cwd) {
  return JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { cwd } });
}

function turnContextLine(cwd) {
  return JSON.stringify({ timestamp: new Date().toISOString(), type: 'turn_context', payload: { cwd } });
}

function userLine(text, turn) {
  return JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', internal_chat_message_metadata_passthrough: { turn_id: turn }, content: [{ type: 'input_text', text }] } });
}

function assistantLine(text, turn, phase = 'final_answer') {
  return JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', phase, internal_chat_message_metadata_passthrough: { turn_id: turn }, content: [{ type: 'output_text', text }] } });
}

function gitInit(dir) {
  return new Promise((resolve, reject) => {
    execFile('git', ['init', '-q'], { cwd: dir, windowsHide: true }, (e) => (e ? reject(e) : resolve()));
  });
}

async function main() {
  await ensureRuntimeHome({ homeDir: HOME, version: '0.1.0' });
  fs.mkdirSync(SESSIONS, { recursive: true });

  // Two real workspaces with distinct workspaceIds.
  const ccs = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-codex-ccs-'));
  const ccb = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-codex-ccb-'));
  await gitInit(ccs);
  await gitInit(ccb);
  const ccsIdentity = (await resolveRepoContext(ccs)).repoIdentity;
  const ccbIdentity = (await resolveRepoContext(ccb)).repoIdentity;
  assert.ok(ccsIdentity && ccbIdentity && ccsIdentity.workspaceId !== ccbIdentity.workspaceId);

  // Multi-repo interleave: A(CCS) user, B(CCB) user, A assistant, B assistant.
  // Workspace comes from session_meta payload cwd, never from the session
  // file location and never from mtime.
  const fileA = sessionFile('aaa111');
  const fileB = sessionFile('bbb222');
  fs.writeFileSync(fileA, sessionMetaLine(ccs) + '\n' + userLine('fix the parser in widgets', 'turn-a1') + '\n');
  fs.writeFileSync(fileB, sessionMetaLine(ccb) + '\n' + userLine('unrelated radar task', 'turn-b1') + '\n');

  const r1 = await codex.main({ home: HOME, payload: { session_id: 'aaa111' } });
  assert.strictEqual(r1.status, 'captured');
  assert.strictEqual(r1.captured, 1);
  const r2 = await codex.main({ home: HOME, payload: { session_id: 'bbb222' } });
  assert.strictEqual(r2.captured, 1);

  // Partial trailing line stays unread; completes later, consumed once.
  fs.appendFileSync(fileA, assistantLine('parser fix ready', 'turn-a1') + '\n');
  const partialFull = userLine('partial line that never finished', 'turn-a2') + '\n';
  fs.appendFileSync(fileA, partialFull.slice(0, 25));
  const r3 = await codex.main({ home: HOME, payload: { session_id: 'aaa111' } });
  assert.strictEqual(r3.captured, 1, 'complete assistant line captured');
  fs.appendFileSync(fileA, partialFull.slice(25));
  const r4 = await codex.main({ home: HOME, payload: { session_id: 'aaa111' } });
  assert.strictEqual(r4.captured, 1);

  fs.appendFileSync(fileB, assistantLine('radar task done', 'turn-b1') + '\n');
  const r5 = await codex.main({ home: HOME, payload: { session_id: 'bbb222' } });
  assert.strictEqual(r5.captured, 1);

  // Restart determinism: re-running with no new bytes captures nothing.
  const r6 = await codex.main({ home: HOME, payload: { session_id: 'aaa111' } });
  assert.strictEqual(r6.captured, 0);

  // Codex can continue one task into multiple rollout files. v0.1.1 pinned
  // the cursor to the first file forever; v2 migrates that exact offset and
  // consumes every continuation in deterministic path order without replay.
  const multiId = 'multi777';
  const multiFirst = sessionFile(multiId);
  fs.writeFileSync(multiFirst, sessionMetaLine(ccs) + '\n' + userLine('first rollout prompt', 'turn-m1') + '\n' + assistantLine('first rollout reply', 'turn-m1') + '\n');
  const firstCapture = await codex.main({ home: HOME, payload: { session_id: multiId } });
  assert.strictEqual(firstCapture.captured, 2);
  const cursorPath = path.join(HOME, 'cursors', 'codex', `${multiId}.json`);
  const v2BeforeMigration = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
  const firstState = Object.values(v2BeforeMigration.files)[0];
  fs.writeFileSync(cursorPath, JSON.stringify({
    sessionId: multiId,
    filePath: firstState.filePath,
    byteOffset: firstState.byteOffset,
    lastRecordKey: firstState.lastRecordKey,
    activeCwd: firstState.activeCwd,
    repoIdentity: firstState.repoIdentity,
    projectPath: firstState.projectPath,
    branch: firstState.branch,
    headAtCapture: firstState.headAtCapture,
  }));
  const multiSecond = continuationFile(multiId, 'continuation-a', '19');
  const multiThird = continuationFile(multiId, 'continuation-b', '20');
  fs.writeFileSync(multiSecond, sessionMetaLine(ccs) + '\n' + userLine('second rollout prompt', 'turn-m2') + '\n' + assistantLine('working on continuation', 'turn-m2', 'commentary') + '\n');
  fs.writeFileSync(multiThird, sessionMetaLine(ccs) + '\n' + assistantLine('continuation complete', 'turn-m2') + '\n');
  const migrated = await codex.main({ home: HOME, payload: { session_id: multiId } });
  assert.strictEqual(migrated.captured, 3, 'only the two new rollout files are recovered');
  assert.strictEqual(migrated.files, 3);
  const v2AfterMigration = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
  assert.strictEqual(v2AfterMigration.schema, 'codex-cursor/v2');
  assert.strictEqual(Object.keys(v2AfterMigration.files).length, 3, 'every rollout owns an independent cursor');
  const afterMigrationAgain = await codex.main({ home: HOME, payload: { session_id: multiId } });
  assert.strictEqual(afterMigrationAgain.captured, 0, 'repeated notify does not replay any rollout');

  // Concurrent wake-ups serialize the cursor update; stable event keys are a
  // second idempotency boundary if a process retries after journal append.
  const concurrentId = 'race888';
  fs.writeFileSync(sessionFile(concurrentId), sessionMetaLine(ccs) + '\n' + userLine('capture once under concurrent notify', 'turn-r1') + '\n');
  const concurrent = await Promise.all([
    codex.main({ home: HOME, payload: { session_id: concurrentId } }),
    codex.main({ home: HOME, payload: { session_id: concurrentId } }),
  ]);
  assert.deepStrictEqual(concurrent.map(result => result.captured).sort(), [0, 1]);

  // turn_context cwd change: subsequent events switch workspace, prior stay.
  const fileC = sessionFile('ccc333');
  fs.writeFileSync(fileC, sessionMetaLine(ccs) + '\n' + userLine('start in ccs', 'turn-c1') + '\n');
  await codex.main({ home: HOME, payload: { session_id: 'ccc333' } });
  fs.appendFileSync(fileC, turnContextLine(ccb) + '\n' + userLine('moved to ccb', 'turn-c2') + '\n' + assistantLine('reply in ccb', 'turn-c2') + '\n');
  await codex.main({ home: HOME, payload: { session_id: 'ccc333' } });

  // Workspace-unresolved: no authoritative cwd anywhere in the session.
  const fileD = sessionFile('ddd444');
  fs.writeFileSync(fileD, userLine('no cwd metadata at all', 'turn-d1') + '\n');
  const unresolved = await codex.main({ home: HOME, payload: { session_id: 'ddd444' } });
  assert.strictEqual(unresolved.status, 'captured');
  assert.strictEqual(unresolved.captured, 1);

  // Capture-disable: zero journal writes even with pending bytes.
  const fileE = sessionFile('eee555');
  fs.writeFileSync(fileE, sessionMetaLine(ccs) + '\n' + userLine('internal session', 'turn-e1') + '\n');
  const previousCapture = process.env.AI_CODING_EVENT_BRIDGE_CAPTURE;
  process.env.AI_CODING_EVENT_BRIDGE_CAPTURE = '0';
  try {
    const journalProbe = new Journal(path.join(HOME, 'journal'));
    const before = (await journalProbe.readEvents({})).length;
    const disabled = await codex.main({ home: HOME, payload: { session_id: 'eee555' } });
    assert.deepStrictEqual(disabled, { status: 'ignored', reason: 'capture-disabled' });
    assert.strictEqual((await journalProbe.readEvents({})).length, before, 'capture-disabled consumes nothing');
  } finally {
    if (previousCapture === undefined) delete process.env.AI_CODING_EVENT_BRIDGE_CAPTURE;
    else process.env.AI_CODING_EVENT_BRIDGE_CAPTURE = previousCapture;
  }

  // Ambiguous notify records a gap and never touches the newest file by mtime.
  fs.utimesSync(fileB, new Date(), new Date(Date.now() + 10_000));
  const gap = await codex.main({ home: HOME, payload: { event: 'notify', cwd: '/somewhere' } });
  assert.strictEqual(gap.status, 'gap');
  assert.strictEqual(gap.reason, 'notify-session-unresolved');

  // Unknown session id is an explicit gap, not a guess.
  const missing = await codex.main({ home: HOME, payload: { session_id: 'zzz999' } });
  assert.strictEqual(missing.status, 'gap');

  const journal = new Journal(path.join(HOME, 'journal'));
  const events = await journal.readEvents({});
  const prompts = events.filter(e => e.eventType === 'user_prompt');
  assert.deepStrictEqual(
    prompts.map(p => `${p.sessionId}:${p.content}`),
    [
      'aaa111:fix the parser in widgets',
      'bbb222:unrelated radar task',
      'aaa111:partial line that never finished',
      'multi777:first rollout prompt',
      'multi777:second rollout prompt',
      'race888:capture once under concurrent notify',
      'ccc333:start in ccs',
      'ccc333:moved to ccb',
      'ddd444:no cwd metadata at all'
    ],
    'every prompt attributed to its own session regardless of file mtime'
  );

  // Zero cross attribution between the two workspaces.
  const sessionA = events.filter(e => e.sessionId === 'aaa111');
  const sessionB = events.filter(e => e.sessionId === 'bbb222');
  assert.ok(sessionA.every(e => e.repoIdentity && e.repoIdentity.workspaceId === ccsIdentity.workspaceId));
  assert.ok(sessionB.every(e => e.repoIdentity && e.repoIdentity.workspaceId === ccbIdentity.workspaceId));
  assert.strictEqual(sessionA.length, 3);
  assert.strictEqual(sessionB.length, 2);

  // turn_context switch: first ccc333 event keeps CCS, later ones carry CCB.
  const sessionC = events.filter(e => e.sessionId === 'ccc333');
  assert.strictEqual(sessionC[0].repoIdentity.workspaceId, ccsIdentity.workspaceId, 'prior events keep their resolved identity');
  assert.ok(sessionC.slice(1).every(e => e.repoIdentity.workspaceId === ccbIdentity.workspaceId), 'subsequent events use the new authoritative workspace');

  // Unresolved session: message kept as global evidence but never bound.
  const sessionD = events.filter(e => e.sessionId === 'ddd444');
  assert.strictEqual(sessionD.length, 1);
  assert.strictEqual(sessionD[0].repoIdentity, null, 'no guessed repoIdentity even though CCS/CCB were recently active');
  const gapsRaw = fs.readFileSync(path.join(HOME, 'journal', 'capture-gaps.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert(gapsRaw.some(g => g.reason === 'codex-workspace-unresolved' && g.sessionId === 'ddd444'));
  assert(gapsRaw.some(g => g.reason === 'notify-session-unresolved' && g.source === 'codex'));

  // User + assistant share the durable turn via canonical append.
  const pairA = sessionA.filter(e => e.turnId === 'turn-a1');
  assert.strictEqual(pairA.length, 2, 'client turn ids preserved durably');

  const multiEvents = events.filter(e => e.sessionId === multiId);
  assert.deepStrictEqual(
    multiEvents.map(event => event.content),
    ['first rollout prompt', 'first rollout reply', 'second rollout prompt', 'working on continuation', 'continuation complete'],
    'all rollout files are projected once in chronological order'
  );
  assert.ok(multiEvents.every(event => event.repoIdentity.workspaceId === ccsIdentity.workspaceId));
  assert.strictEqual(multiEvents[2].turnId, 'turn-m2', 'real nested Codex turn identity is preserved');
  assert.strictEqual(multiEvents[3].turnId, 'turn-m2');
  assert.strictEqual(multiEvents[4].turnId, 'turn-m2');
  assert.strictEqual(multiEvents[3].meta.phase, 'commentary', 'assistant phase survives for downstream projection');
  assert.strictEqual(multiEvents[4].meta.phase, 'final_answer');

  const concurrentEvents = events.filter(e => e.sessionId === concurrentId);
  assert.strictEqual(concurrentEvents.length, 1, 'concurrent notification writes one durable event');

  console.log('codex-capture-test PASS');
}

module.exports = main();
