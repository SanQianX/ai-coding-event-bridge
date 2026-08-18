'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Journal } = require('../src/core/journal');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-journal-concurrency-'));

function runWorker(homeDir, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'helpers', 'append-worker.js'), homeDir, String(count)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`worker failed: ${out}`))));
  });
}

async function main() {
  const journal = new Journal(path.join(HOME, 'journal'));

  // Same-process concurrent appends serialize into unique monotonic sequences.
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      journal.appendEvent({
        source: 'claude-code',
        eventType: 'user_prompt',
        role: 'user',
        content: `prompt ${i}`,
        repoIdentity: 'repo-a',
        turnId: `turn-a-${i}`
      })
    )
  );
  const sequences = results.map((r) => r.sequence).sort((a, b) => a - b);
  assert.deepStrictEqual(sequences, Array.from({ length: 40 }, (_, i) => i + 1), 'sequences must be 1..40 unique');
  assert.strictEqual(journal.lastSequence, 40);

  // Two external processes append concurrently into the same journal.
  const [outA, outB] = await Promise.all([runWorker(HOME, 15), runWorker(HOME, 15)]);
  assert.ok(JSON.parse(outA), 'worker A reports bounds');
  assert.ok(JSON.parse(outB), 'worker B reports bounds');

  const reopened = new Journal(path.join(HOME, 'journal'));
  const events = await reopened.readEvents({});
  assert.strictEqual(events.length, 70, '40 + 15 + 15 events expected');
  const allSeqs = events.map((e) => e.sequence).sort((a, b) => a - b);
  assert.deepStrictEqual(allSeqs, Array.from({ length: 70 }, (_, i) => i + 1), 'cross-process sequences must stay unique and dense');

  const rawLines = fs.readFileSync(path.join(HOME, 'journal', 'events.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(rawLines.length, 70, 'every sequence must be one durable JSONL line');
  for (const line of rawLines) {
    assert.doesNotThrow(() => JSON.parse(line), 'journal lines must be complete JSON objects');
  }

  console.log('journal-concurrency-test PASS');
}

module.exports = main();
