'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureRuntimeHome } = require('../src/core/runtime-home');
const { Journal } = require('../src/core/journal');
const codex = require('../src/connectors/codex/hook-entry');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-codex-'));
const SESSIONS = path.join(HOME, 'fixtures', 'codex-sessions', '2026', '08', '18');

function sessionFile(id) {
  return path.join(SESSIONS, `rollout-2026-08-18-${id}.jsonl`);
}

function userLine(text, turn) {
  return JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', turn_id: turn, content: [{ type: 'input_text', text }] } });
}

function assistantLine(text, turn) {
  return JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', turn_id: turn, content: [{ type: 'output_text', text }] } });
}

async function main() {
  await ensureRuntimeHome({ homeDir: HOME, version: '0.1.0' });
  fs.mkdirSync(SESSIONS, { recursive: true });

  // Two concurrent Codex sessions in different repos, appended interleaved.
  const fileA = sessionFile('aaa111');
  const fileB = sessionFile('bbb222');
  fs.writeFileSync(fileA, userLine('fix the parser in widgets', 'turn-a1') + '\n');
  fs.writeFileSync(fileB, userLine('unrelated radar task', 'turn-b1') + '\n');

  const r1 = await codex.main({ home: HOME, payload: { session_id: 'aaa111', repo_identity: 'github.com/acme/widgets' } });
  assert.strictEqual(r1.status, 'captured');
  assert.strictEqual(r1.captured, 1);

  // Partial trailing line stays unread.
  fs.appendFileSync(fileA, assistantLine('parser fix ready', 'turn-a1') + '\n');
  fs.appendFileSync(fileA, userLine('partial line that never', 'turn-a2').slice(0, 25));
  const r2 = await codex.main({ home: HOME, payload: { session_id: 'aaa111', repo_identity: 'github.com/acme/widgets' } });
  assert.strictEqual(r2.captured, 1, 'complete assistant line captured');

  // The partial line completes later and is then consumed exactly once.
  const partialRaw = userLine('partial line that never finished', 'turn-a2') + '\n';
  fs.appendFileSync(fileA, partialRaw.slice(25));
  const r3 = await codex.main({ home: HOME, payload: { session_id: 'aaa111', repo_identity: 'github.com/acme/widgets' } });
  assert.strictEqual(r3.captured, 1);

  // The other session captures independently; no cross-session attribution.
  const r4 = await codex.main({ home: HOME, payload: { session_id: 'bbb222', repo_identity: 'github.com/acme/radar' } });
  assert.strictEqual(r4.captured, 1);

  // Restart determinism: re-running with no new bytes captures nothing.
  const r5 = await codex.main({ home: HOME, payload: { session_id: 'aaa111', repo_identity: 'github.com/acme/widgets' } });
  assert.strictEqual(r5.captured, 0);

  // Ambiguous notify records a gap and never touches the newest file by mtime.
  fs.utimesSync(fileB, new Date(), new Date(Date.now() + 10_000));
  const gap = await codex.main({ home: HOME, payload: { event: 'notify', cwd: '/somewhere' } });
  assert.strictEqual(gap.status, 'gap');
  assert.strictEqual(gap.reason, 'notify-session-unresolved');
  const gapsRaw = fs.readFileSync(path.join(HOME, 'journal', 'capture-gaps.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert(gapsRaw.some(g => g.reason === 'notify-session-unresolved' && g.source === 'codex'));

  // Unknown session id is an explicit gap, not a guess.
  const missing = await codex.main({ home: HOME, payload: { session_id: 'zzz999' } });
  assert.strictEqual(missing.status, 'gap');

  const journal = new Journal(path.join(HOME, 'journal'));
  const events = await journal.readEvents({});
  const prompts = events.filter(e => e.eventType === 'user_prompt');
  assert.deepStrictEqual(
    prompts.map(p => `${p.sessionId}:${p.content}`),
    ['aaa111:fix the parser in widgets', 'aaa111:partial line that never finished', 'bbb222:unrelated radar task'],
    'every prompt attributed to its own session regardless of file mtime'
  );
  const widgets = events.filter(e => e.sessionId === 'aaa111');
  assert.ok(widgets.every(e => e.repoIdentity === 'github.com/acme/widgets'));
  assert.strictEqual(events.filter(e => e.sessionId === 'bbb222')[0].repoIdentity, 'github.com/acme/radar');

  console.log('codex-capture-test PASS');
}

module.exports = main();
