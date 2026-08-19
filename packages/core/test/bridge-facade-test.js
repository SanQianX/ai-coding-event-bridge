'use strict';

// T07: stable createBridge() facade. Hosts use only these methods; commit
// boundaries return the frozen contract shape; consumers and health behave
// per the host contract.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBridge } = require('../src/core/bridge');
const { buildRepoIdentityV1 } = require('../src/core/repo-context');

const CCS = buildRepoIdentityV1({ workspaceRoot: 'D:\\Projects\\CCS', remote: 'github.com/acme/ccs' });

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-facade-'));
  const bridge = createBridge({ homeDir: home });

  assert.strictEqual(bridge.homeDir, home);
  assert.strictEqual(await bridge.getHighWatermark(), 0);

  const user = await bridge.appendConversationEvent({
    source: 'claude-code', eventType: 'user_prompt', role: 'user',
    content: 'facade prompt', sessionId: 's1', repoIdentity: CCS
  });
  const assistant = await bridge.appendConversationEvent({
    source: 'claude-code', eventType: 'assistant_response', role: 'assistant',
    content: 'facade reply', sessionId: 's1', repoIdentity: CCS
  });
  assert.strictEqual(assistant.turnId, user.turnId);
  assert.strictEqual(await bridge.getHighWatermark(), 2);

  const events = await bridge.readEvents({ fromSequence: 1, toSequence: 2 });
  assert.strictEqual(events.length, 2);

  // Commit boundary: atomic under the journal lock, frozen return shape.
  const boundary = await bridge.appendCommitBoundary({
    projectId: 'ccs-project',
    repoIdentity: CCS,
    commitSha: 'a'.repeat(40),
    parentShas: ['b'.repeat(40)],
    branch: 'main',
    committedAt: '2026-08-20T00:00:00.000Z',
    operationId: 'op-1'
  });
  assert.strictEqual(boundary.sequence, 3);
  assert.strictEqual(boundary.bridgeCursorAtCommit, 3);
  assert.deepStrictEqual(boundary.openTurnIdsAtCommit, [], 'the completed turn is closed at boundary time');
  assert.strictEqual(boundary.previousRepoBoundarySequence, null);
  assert.strictEqual(boundary.committedAt, '2026-08-20T00:00:00.000Z');

  const secondBoundary = await bridge.appendCommitBoundary({
    repoIdentity: CCS, commitSha: 'c'.repeat(40)
  });
  assert.strictEqual(secondBoundary.previousRepoBoundarySequence, 3);

  let rejected = false;
  try {
    await bridge.appendCommitBoundary({ commitSha: 'd'.repeat(40) });
  } catch (_) {
    rejected = true;
  }
  assert.ok(rejected, 'boundary without repoIdentity must be rejected');

  // Consumer lifecycle through the facade.
  await bridge.registerConsumer('project-knowledge', { notifyUrl: 'http://127.0.0.1:9/x' });
  await bridge.registerConsumer('devtask-radar');
  const consumers = await bridge.listConsumers();
  assert.deepStrictEqual(consumers.map((c) => c.name).sort(), ['devtask-radar', 'project-knowledge']);
  assert.strictEqual((await bridge.getConsumer('project-knowledge')).ack, 0);
  assert.strictEqual(await bridge.getConsumer('nope'), null);

  await bridge.ackConsumerCursor('project-knowledge', boundary.sequence);
  assert.strictEqual((await bridge.getConsumer('project-knowledge')).ack, boundary.sequence);

  // Health shape.
  const health = await bridge.getHealth();
  assert.strictEqual(health.lastSequence, secondBoundary.sequence);
  assert.ok(health.firstSequence <= 1, 'firstSequence is 0 or 1 before any compaction rebuild');
  assert.ok(Number.isInteger(health.journalSizeBytes) && health.journalSizeBytes > 0);
  assert.strictEqual(health.minConsumerAck, 0);
  assert.strictEqual(health.consumers.length, 2);
  assert.ok(health.consumers.every((c) => typeof c.name === 'string' && Number.isInteger(c.ack)));

  // Compaction bounded by the slowest consumer.
  const compacted = await bridge.compact({ throughSequence: boundary.sequence });
  assert.strictEqual(compacted.removedCount, 0, 'min ack is 0, no record may be removed');
  await bridge.ackConsumerCursor('devtask-radar', boundary.sequence);
  const afterBoth = await bridge.compact({ throughSequence: boundary.sequence });
  assert.strictEqual(afterBoth.compactedThrough, boundary.sequence);
  const boundsAfter = await bridge.readEvents({});
  assert.ok(boundsAfter.every((e) => e.sequence > boundary.sequence),
    'no unacked record was removed');

  await bridge.unregisterConsumer('devtask-radar');
  assert.strictEqual((await bridge.getConsumer('devtask-radar')), null);
  assert.strictEqual((await bridge.getConsumer('project-knowledge')).name, 'project-knowledge');

  console.log('bridge-facade-test PASS');
}

module.exports = main();
