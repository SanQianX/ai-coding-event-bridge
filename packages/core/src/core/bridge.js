'use strict';

const fs = require('fs');
const path = require('path');
const { bridgeHome } = require('./paths');
const { Journal } = require('./journal');
const { ConsumerRegistry } = require('./consumer-registry');
const { compactJournal } = require('./compaction');

/**
 * Stable host-facing facade over the Bridge runtime. Hosts (Project-Knowledge,
 * DevTask-Radar, ...) must talk to this facade only — never to Journal
 * internals or Bridge filesystem layout.
 */
function createBridge({ homeDir } = {}) {
  const home = bridgeHome(homeDir);
  // Lazy internals: constructing a facade must not touch the filesystem, so
  // merely loading a Bridge (e.g. in a host test) creates no runtime home.
  let journal = null;
  let registry = null;
  const getJournal = () => {
    if (!journal) journal = new Journal(path.join(home, 'journal'));
    return journal;
  };
  const getRegistry = () => {
    if (!registry) registry = new ConsumerRegistry(home);
    return registry;
  };
  // Pure reads on a machine where no Bridge home exists yet must not
  // materialize one: status queries stay side-effect free.
  const homeExists = () => fs.existsSync(home);

  return {
    homeDir: home,

    async getHighWatermark() {
      if (!homeExists()) return 0;
      const bounds = await getJournal().getBounds();
      return bounds.lastSequence;
    },

    async readEvents(options = {}) {
      return getJournal().readEvents(options);
    },

    // Host-side injection for tests and explicit workflows; automatic capture
    // flows through the connectors' canonical append path.
    async appendConversationEvent(event) {
      return getJournal().appendConversationEvent(event);
    },

    async appendCommitBoundary({ projectId, repoIdentity, commitSha, parentShas, parents, branch, committedAt, operationId, meta } = {}) {
      if (!repoIdentity) {
        throw new Error('appendCommitBoundary requires repoIdentity');
      }
      const result = await getJournal().appendCommitBoundary(repoIdentity, {
        commitSha,
        parents: parents !== undefined ? parents : parentShas,
        branch,
        committedAt,
        projectId,
        operationId,
        meta
      });
      return {
        sequence: result.sequence,
        bridgeCursorAtCommit: result.sequence,
        openTurnIdsAtCommit: result.openTurnIdsAtCommit,
        previousRepoBoundarySequence: result.previousRepoBoundarySequence,
        committedAt: committedAt || new Date().toISOString()
      };
    },

    async registerConsumer(name, meta = {}) {
      return getRegistry().registerConsumer(name, meta);
    },

    async getConsumer(name) {
      if (!homeExists()) return null;
      const consumers = await getRegistry().getConsumers();
      return consumers.find((consumer) => consumer.name === name) || null;
    },

    async listConsumers() {
      if (!homeExists()) return [];
      return getRegistry().getConsumers();
    },

    async ackConsumerCursor(name, sequence) {
      return getRegistry().ackConsumerCursor(name, sequence);
    },

    async unregisterConsumer(name) {
      return getRegistry().unregisterConsumer(name);
    },

    async compact({ throughSequence } = {}) {
      return compactJournal(getJournal(), getRegistry(), { throughSequence });
    },

    async getHealth() {
      if (!homeExists()) {
        return {
          journalSizeBytes: 0,
          firstSequence: 0,
          lastSequence: 0,
          minConsumerAck: null,
          oldestUnackedAt: null,
          consumers: []
        };
      }
      const liveJournal = getJournal();
      const [bounds, consumers, minConsumerAck] = await Promise.all([
        liveJournal.getBounds(),
        getRegistry().getConsumers(),
        getRegistry().getMinAck()
      ]);
      let journalSizeBytes = 0;
      try {
        journalSizeBytes = fs.statSync(liveJournal.eventsFile).size;
      } catch (_) {
        journalSizeBytes = 0;
      }
      let oldestUnackedAt = null;
      if (minConsumerAck !== null && bounds.lastSequence > minConsumerAck) {
        try {
          const pending = await liveJournal.readEvents({ fromSequence: minConsumerAck + 1, toSequence: minConsumerAck + 1, limit: 1 });
          if (pending.length) oldestUnackedAt = pending[0].capturedAt || null;
        } catch (_) {
          oldestUnackedAt = null;
        }
      }
      return {
        journalSizeBytes,
        firstSequence: bounds.firstSequence,
        lastSequence: bounds.lastSequence,
        minConsumerAck,
        oldestUnackedAt,
        consumers: consumers.map((consumer) => ({
          name: consumer.name,
          ack: consumer.ack,
          lastSeenAt: consumer.lastSeenAt || null
        }))
      };
    },

    // Introspection helpers for diagnostics; not part of the frozen contract.
    get _journal() { return journal; },
    get _registry() { return registry; }
  };
}

module.exports = { createBridge };
