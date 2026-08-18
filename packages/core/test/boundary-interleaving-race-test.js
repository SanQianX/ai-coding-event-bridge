'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Journal, BOUNDARY_SCHEMA } = require('../src/core/journal');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-boundary-race-'));
const REPO = 'git@github.com:acme/race.git';

function runWorker(homeDir, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, 'helpers', 'append-worker.js'), homeDir, String(count), REPO],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let err = '';
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`worker failed: ${err}`))));
  });
}

async function main() {
  const journal = new Journal(path.join(HOME, 'journal'));

  // Deterministic same-process ordering first.
  const prompt1 = await journal.appendEvent({
    source: 'codex',
    eventType: 'user_prompt',
    role: 'user',
    content: 'before boundary',
    repoIdentity: REPO,
    turnId: 'turn-det-1'
  });
  const boundary1 = await journal.appendCommitBoundary(REPO, { commitSha: 'c1', branch: 'main' });
  assert.deepStrictEqual(boundary1.openTurnIdsAtCommit, ['turn-det-1'], 'open prompt must be frozen into the boundary');
  await journal.appendEvent({
    source: 'codex',
    eventType: 'assistant_response',
    role: 'assistant',
    content: 'closing reply',
    repoIdentity: REPO,
    turnId: 'turn-det-1'
  });
  const boundary2 = await journal.appendCommitBoundary(REPO, { commitSha: 'c2', branch: 'main' });
  assert.deepStrictEqual(boundary2.openTurnIdsAtCommit, [], 'closed turn must not leak into later boundaries');
  assert.strictEqual(boundary2.previousRepoBoundarySequence, boundary1.sequence, 'repo boundary chain must link');

  // Cross-process race: a child appends user prompts while this process appends
  // boundaries. Every boundary must freeze exactly the prompts ordered before it.
  const workerDone = runWorker(HOME, 25);
  const boundaries = [];
  while (boundaries.length < 12) {
    const boundary = await journal.appendCommitBoundary(REPO, {
      commitSha: `race-${boundaries.length}`,
      branch: 'main'
    });
    boundaries.push(boundary);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await workerDone;
  boundaries.push(await journal.appendCommitBoundary(REPO, { commitSha: 'race-final', branch: 'main' }));

  const final = new Journal(path.join(HOME, 'journal'));
  const all = await final.readEvents({});
  const prompts = all.filter((e) => e.eventType === 'user_prompt' && e.repoIdentity === REPO);
  const promptSeqByTurn = new Map(prompts.map((p) => [p.turnId, p.sequence]));
  const closeSeqByTurn = new Map();
  for (const e of all) {
    if (e.eventType === 'assistant_response' && e.turnId && !closeSeqByTurn.has(e.turnId)) {
      closeSeqByTurn.set(e.turnId, e.sequence);
    }
  }

  const raceBoundaries = all.filter((e) => e.schema === BOUNDARY_SCHEMA && e.commitSha && e.commitSha.startsWith('race-'));
  assert.ok(raceBoundaries.length >= 13, 'expected the interleaved race boundaries in the journal');

  for (const boundary of raceBoundaries) {
    const expected = [];
    for (const [turnId, seq] of promptSeqByTurn) {
      if (seq >= boundary.sequence) continue;
      const close = closeSeqByTurn.get(turnId);
      if (close !== undefined && close < boundary.sequence) continue;
      expected.push(turnId);
    }
    assert.deepStrictEqual(
      [...boundary.openTurnIdsAtCommit].sort(),
      expected.sort(),
      `boundary seq=${boundary.sequence} must freeze exactly the prompts appended before it under the journal lock`
    );
  }

  console.log('boundary-interleaving-race-test PASS');
}

module.exports = main();
