'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Journal } = require('../src/core/journal');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-crash-recovery-'));

async function main() {
  const eventsFile = path.join(HOME, 'journal', 'events.jsonl');

  // Scenario 1: crash left a partial (mid-line) tail without a trailing newline.
  const j1 = new Journal(path.join(HOME, 'journal'));
  for (let i = 0; i < 5; i++) {
    await j1.appendEvent({
      source: 'opencode',
      eventType: 'user_prompt',
      role: 'user',
      content: `p${i}`,
      repoIdentity: 'repo-c',
      turnId: `t${i}`
    });
  }
  fs.appendFileSync(eventsFile, '{"schema":"ai-coding-event/v1","eventId":"partial-');
  const j2 = new Journal(path.join(HOME, 'journal'));
  const bounds2 = await j2.getBounds();
  assert.strictEqual(bounds2.lastSequence, 5, 'recovery must ignore the partial tail');
  const next = await j2.appendEvent({
    source: 'opencode',
    eventType: 'user_prompt',
    role: 'user',
    content: 'after crash',
    repoIdentity: 'repo-c',
    turnId: 't-after'
  });
  assert.strictEqual(next.sequence, 6, 'sequence continues past recovered tail');
  const all = await j2.readEvents({});
  assert.strictEqual(all.length, 6);
  for (const record of all) {
    assert.ok(typeof record.sequence === 'number' && record.eventId, 'all recovered lines must be complete records');
  }

  // Scenario 2: state.json lags behind the events file (crash between append and state save).
  const stateFile = path.join(HOME, 'journal', 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.lastSequence = 3;
  const openSnapshot = {};
  for (const [key, turn] of Object.entries(state.openTurns)) {
    if (turn.startSequence <= 3) openSnapshot[key] = turn;
  }
  state.openTurns = openSnapshot;
  const rawLines = fs.readFileSync(eventsFile, 'utf8').split('\n');
  let offsetAfter3 = 0;
  for (let i = 0; i < 3; i++) offsetAfter3 += Buffer.byteLength(rawLines[i], 'utf8') + 1;
  state.bytesFlushed = offsetAfter3;
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  const j3 = new Journal(path.join(HOME, 'journal'));
  const openTurns = await j3.getOpenTurns();
  assert.strictEqual(j3.lastSequence, 6, 'tail replay must restore the sequence counter');
  const openIds = openTurns.map((t) => t.turnId).sort();
  assert.deepStrictEqual(openIds, ['t-after', 't0', 't1', 't2', 't3', 't4'], 'tail replay must restore the open-turn projection');

  // Scenario 3: state.json missing entirely -> full replay from the events file.
  fs.rmSync(stateFile, { force: true });
  const j4 = new Journal(path.join(HOME, 'journal'));
  const bounds4 = await j4.getBounds();
  assert.strictEqual(bounds4.lastSequence, 6, 'full replay restores lastSequence');
  const open4 = (await j4.getOpenTurns()).map((t) => t.turnId).sort();
  assert.deepStrictEqual(open4, ['t-after', 't0', 't1', 't2', 't3', 't4'], 'full replay restores projection');

  console.log('journal-crash-recovery-test PASS');
}

module.exports = main();
