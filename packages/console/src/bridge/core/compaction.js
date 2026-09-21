'use strict';

/**
 * Compact the durable journal prefix that every registered consumer has acked.
 * Never removes data beyond minAck; requires at least one registered consumer;
 * runs under the same journal lock as appendEvent/appendCommitBoundary.
 */
async function compactJournal(journal, consumerRegistry, { throughSequence } = {}) {
  const minAck = await consumerRegistry.getMinAck();
  if (minAck === null || minAck === undefined) {
    return { compactedThrough: null, removedCount: 0, reason: 'no-consumers' };
  }
  const target = Math.min(minAck, throughSequence === undefined ? minAck : throughSequence);
  return journal._withJournalLock(async () => {
    if (target < journal.firstSequence) {
      return { compactedThrough: journal.firstSequence - 1, removedCount: 0, reason: 'already-compacted' };
    }
    const removedCount = journal._compactTo(target);
    return { compactedThrough: target, removedCount, reason: 'compacted' };
  });
}

module.exports = { compactJournal };
