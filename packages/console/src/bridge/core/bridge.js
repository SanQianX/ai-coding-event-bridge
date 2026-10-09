'use strict';

const fs = require('fs');
const path = require('path');
const { bridgeHome } = require('./paths');
const { Journal } = require('./journal');
const { ConsumerRegistry } = require('./consumer-registry');
const { compactJournal } = require('./compaction');
const { journalFor, globalJournalDir } = require('./journal-router');
const projectRegistry = require('./project-registry');
const { sealCommitConversations, sealDirFor } = require('./commit-projection');
const { resolveRepoContext } = require('./repo-context');
const { validateAndNormalizeEvent } = require('./event-schema');
const { notifyConsumers } = require('../connectors/claude-code/notify');

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
  const selectJournal = (journalId = 'global') => {
    if (journalId === 'global') return getJournal();
    const project = projectRegistry.listProjects(home).find(p => p.id === journalId);
    if (!project) throw Object.assign(new Error('journal is not registered'), { code: 'JOURNAL_NOT_FOUND' });
    return journalFor(home, project.id);
  };

  return {
    homeDir: home,

    async listJournals() {
      return [{ journalId: 'global', projectId: null }, ...projectRegistry.listProjects(home).map(p => ({ journalId: p.id, projectId: p.id, repoPath: p.path }))];
    },

    async getHighWatermark({ journalId = 'global' } = {}) {
      if (!homeExists()) return 0;
      const bounds = await selectJournal(journalId).getBounds();
      return bounds.lastSequence;
    },

    async readEvents(options = {}) {
      return selectJournal(options.journalId).readEvents(options);
    },

    // Host-side injection for tests and explicit workflows; automatic capture
    // flows through the connectors' canonical append path.
    async appendConversationEvent(event) {
      return getJournal().appendConversationEvent(event);
    },

    async captureWorkbenchEvent(input) {
      if (!['user_prompt', 'assistant_response', 'session_end'].includes(input?.eventType)
        || typeof input.projectPath !== 'string' || !path.isAbsolute(input.projectPath)
        || typeof input.eventKey !== 'string' || !input.eventKey.startsWith('workbench:')
        || !input.sessionId || !input.turnId || input.content && (typeof input.content !== 'string' || input.content.length > 200000)) {
        throw Object.assign(new Error('Invalid native workbench event'), { code: 'CAPTURE_INVALID' });
      }
      const repo = await resolveRepoContext(input.projectPath);
      const project = projectRegistry.findProject(home, repo.repoIdentity);
      if (!project || fs.realpathSync(project.path) !== fs.realpathSync(input.projectPath)) {
        throw Object.assign(new Error('Workbench project is not registered'), { code: 'PROJECT_NOT_REGISTERED' });
      }
      const event = validateAndNormalizeEvent({
        source: input.source, eventType: input.eventType, role: input.eventType === 'user_prompt' ? 'user' : input.eventType === 'assistant_response' ? 'assistant' : null,
        content: input.eventType === 'session_end' ? undefined : input.content, sessionId: input.sessionId, turnId: input.turnId, eventKey: input.eventKey,
        repoIdentity: repo.repoIdentity, projectPath: repo.projectPath, branch: repo.branch, headAtCapture: repo.headAtCapture,
        capturedAt: typeof input.capturedAt === 'string' && !Number.isNaN(Date.parse(input.capturedAt)) ? input.capturedAt : new Date().toISOString(),
        identityConfidence: 'exact', captureStatus: 'complete', meta: { origin: 'claude-ai-workbench', outcome: input.outcome === 'failed' ? 'failed' : 'completed' },
      });
      const appended = await journalFor(home, repo.repoIdentity).appendConversationEvent(event);
      await notifyConsumers(home, { sequence: appended.sequence, eventId: appended.eventId });
      return { status: 'captured', ...appended };
    },

    async appendCommitBoundary({ projectId, repoIdentity, commitSha, parentShas, parents, branch, subject, committedAt, operationId, meta } = {}) {
      if (!repoIdentity) {
        throw new Error('appendCommitBoundary requires repoIdentity');
      }
      // Boundaries live in the same journal as the repo's conversation events
      // (openTurnIdsAtCommit is computed from that journal's open-turn state).
      const journal = journalFor(home, repoIdentity);
      const result = await journal.appendCommitBoundary(repoIdentity, {
        commitSha,
        parents: parents !== undefined ? parents : parentShas,
        branch,
        subject,
        committedAt,
        projectId,
        operationId,
        meta
      });
      const routed = journal.journalDir !== globalJournalDir(home);
      let bridgeCursorAtCommit = result.sequence;
      if (routed) {
        // Routed to a registered project's journal: the boundary is not in the
        // global journal, so the global consumer watermark is unchanged. Keep
        // the returned cursor conservative (never past unseen global content).
        const bounds = await getJournal().getBounds();
        bridgeCursorAtCommit = bounds.lastSequence;
      }
      // A routed boundary means a registered project just committed: freeze
      // that commit's conversations into <store>/commits/<sha>.md. Projection
      // failures are reported, never thrown — the journal remains the only
      // source of truth and the boundary is already durable.
      let projection = { sealed: false, turnCount: 0, reason: routed ? 'project-not-registered' : 'global-journal' };
      if (routed) {
        try {
          const project = projectRegistry.findProject(home, repoIdentity);
          if (project) {
            const sealDir = sealDirFor(project.store);
            projection = await sealCommitConversations({
              journal,
              sealDir,
              boundary: {
                commitSha,
                branch,
                subject,
                committedAt,
                sequence: result.sequence,
                openTurnIdsAtCommit: result.openTurnIdsAtCommit,
                previousRepoBoundarySequence: result.previousRepoBoundarySequence
              }
            });
            // The journal is a conveyor: once the archive copy verifiably
            // exists on disk, drop the sealed prefix. On any miss the prefix
            // stays and the next boundary's seal window covers it (self-heal).
            if (projection.sealed || (projection.reason === 'already-sealed' && fs.existsSync(projection.path))) {
              const minAck = await getRegistry().getMinAck({ journalId: project.id });
              const trim = await journal.trimThrough(minAck === null ? result.sequence : Math.min(result.sequence, minAck));
              projection.trimmedThrough = trim.trimmedThrough;
            }
          }
        } catch (err) {
          projection = { sealed: false, turnCount: 0, error: err && err.message ? err.message : String(err) };
        }
      }
      return {
        sequence: result.sequence,
        journalId: routed ? projectRegistry.findProject(home, repoIdentity).id : 'global',
        bridgeCursorAtCommit,
        openTurnIdsAtCommit: result.openTurnIdsAtCommit,
        previousRepoBoundarySequence: result.previousRepoBoundarySequence,
        committedAt: committedAt || new Date().toISOString(),
        projection
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

    async ackConsumerCursor(name, sequence, options = {}) {
      const high = await this.getHighWatermark(options);
      if (sequence > high) throw Object.assign(new Error('ack exceeds journal high watermark'), { code: 'ACK_OUT_OF_RANGE' });
      return getRegistry().ackConsumerCursor(name, sequence, options);
    },

    async unregisterConsumer(name) {
      return getRegistry().unregisterConsumer(name);
    },

    async compact({ throughSequence, journalId = 'global' } = {}) {
      return compactJournal(selectJournal(journalId), getRegistry(), { throughSequence, journalId });
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
