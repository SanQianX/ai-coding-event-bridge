'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Journal } = require('../src/core/journal');
const { ConsumerRegistry } = require('../src/core/consumer-registry');
const { compactJournal } = require('../src/core/compaction');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-consumer-compaction-'));

async function main() {
  const journal = new Journal(path.join(HOME, 'journal'));
  const registry = new ConsumerRegistry(HOME);

  assert.strictEqual(await registry.getMinAck(), null, 'no consumers -> no minAck');

  for (let i = 1; i <= 10; i++) {
    await journal.appendEvent({
      source: 'claude-code',
      eventType: 'user_prompt',
      role: 'user',
      content: `p${i}`,
      repoIdentity: 'repo-d',
      turnId: `t${i}`
    });
  }

  await registry.registerConsumer('project-knowledge');
  await registry.registerConsumer('devtask-radar');
  assert.strictEqual(await registry.getMinAck(), 0, 'fresh consumers ack 0');

  await registry.ackConsumerCursor('project-knowledge', 10);
  await registry.ackConsumerCursor('devtask-radar', 4);
  assert.strictEqual(await registry.getMinAck(), 4);

  // ack only moves forward
  await registry.ackConsumerCursor('devtask-radar', 2);
  const consumers = await registry.getConsumers();
  const dt = consumers.find((c) => c.name === 'devtask-radar');
  assert.strictEqual(dt.ack, 4, 'ack must never move backwards');

  // compaction is bounded by minAck
  const attempt = await compactJournal(journal, registry, { throughSequence: 8 });
  assert.strictEqual(attempt.compactedThrough, 4, 'compaction may only trim the acked prefix');
  assert.strictEqual(attempt.removedCount, 4);
  const bounds = await journal.getBounds();
  assert.strictEqual(bounds.firstSequence, 5);
  const remaining = await journal.readEvents({});
  assert.deepStrictEqual(
    remaining.map((e) => e.sequence),
    [5, 6, 7, 8, 9, 10]
  );

  // offline consumer is never auto-evicted
  await new Promise((resolve) => setTimeout(resolve, 30));
  const stillThere = (await registry.getConsumers()).map((c) => c.name).sort();
  assert.deepStrictEqual(stillThere, ['devtask-radar', 'project-knowledge']);

  // unregistering the lagging consumer lets minAck advance
  await registry.unregisterConsumer('devtask-radar');
  assert.strictEqual(await registry.getMinAck(), 10);
  const compacted = await compactJournal(journal, registry);
  assert.strictEqual(compacted.compactedThrough, 10);
  const after = await journal.readEvents({});
  assert.strictEqual(after.length, 0, 'fully acked prefix compacted away');
  assert.strictEqual((await journal.getBounds()).firstSequence, 11);

  // appends continue after compaction
  const next = await journal.appendEvent({
    source: 'codex',
    eventType: 'user_prompt',
    role: 'user',
    content: 'post-compact',
    repoIdentity: 'repo-d',
    turnId: 'tp'
  });
  assert.strictEqual(next.sequence, 11);

  // last consumer leaves -> compaction disabled again
  await registry.unregisterConsumer('project-knowledge');
  assert.strictEqual(await registry.getMinAck(), null);
  const disabled = await compactJournal(journal, registry);
  assert.strictEqual(disabled.reason, 'no-consumers');
  assert.strictEqual(disabled.removedCount, 0);

  console.log('consumer-cursor-compaction-test PASS');
}

module.exports = main();
