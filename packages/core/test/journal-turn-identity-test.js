'use strict';

// T03: canonical durable turn identity at append time. The durable record —
// not a projection — must carry the canonical turnId, duplicates must not
// mint second identities, and cross-workspace binding is forbidden.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Journal } = require('../src/core/journal');
const { buildRepoIdentityV1 } = require('../src/core/repo-context');
const { deriveTurnState } = require('../src/core/turn-identity');

function tempJournalDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-turn-id-'));
}

const CCS = buildRepoIdentityV1({ workspaceRoot: 'D:\\Projects\\CCS', remote: 'github.com/acme/ccs' });
const CCB = buildRepoIdentityV1({ workspaceRoot: 'D:\\Projects\\CCB', remote: 'github.com/acme/ccb' });

function userPrompt({ sessionId, repoIdentity = CCS, turnId, content = 'prompt', eventKey } = {}) {
  return { source: 'claude-code', eventType: 'user_prompt', role: 'user', content, sessionId, turnId, repoIdentity, eventKey };
}

function assistant({ sessionId, repoIdentity = CCS, turnId, content = 'reply', eventKey } = {}) {
  return { source: 'claude-code', eventType: 'assistant_response', role: 'assistant', content, sessionId, turnId, repoIdentity, eventKey };
}

async function main() {
  // 1. user without turnId gets a persisted Bridge-owned turn id.
  const dirA = tempJournalDir();
  const journalA = new Journal(path.join(dirA, 'journal'));
  const userA = await journalA.appendConversationEvent(userPrompt({ sessionId: 's1' }));
  assert.strictEqual(userA.duplicate, false);
  assert.match(userA.turnId, /^turn_[0-9a-f-]{36}$/);
  const [recordA] = await journalA.readEvents({ fromSequence: userA.sequence, toSequence: userA.sequence });
  assert.strictEqual(recordA.turnId, userA.turnId, 'durable record carries the canonical turnId');
  assert.strictEqual(recordA.identityConfidence, 'exact', 'assignment raises evidence to exact');

  // 2. assistant without turnId binds to the single open turn of its session.
  const replyA = await journalA.appendConversationEvent(assistant({ sessionId: 's1' }));
  assert.strictEqual(replyA.turnId, userA.turnId, 'assistant gets the same durable turnId');
  const openA = await journalA.getOpenTurns(CCS);
  assert.strictEqual(openA.length, 0, 'bound assistant closes the turn');

  // 3. two open same-session turns => assistant stays ambiguous, never guessed.
  const dirB = tempJournalDir();
  const journalB = new Journal(path.join(dirB, 'journal'));
  const u1 = await journalB.appendConversationEvent(userPrompt({ sessionId: 'sx' }));
  const u2 = await journalB.appendConversationEvent(userPrompt({ sessionId: 'sx' }));
  assert.notStrictEqual(u1.turnId, u2.turnId);
  const ambiguous = await journalB.appendConversationEvent(assistant({ sessionId: 'sx' }));
  assert.strictEqual(ambiguous.turnId, null, 'ambiguous assistant keeps turnId null');
  const [ambiguousRecord] = await journalB.readEvents({ fromSequence: ambiguous.sequence, toSequence: ambiguous.sequence });
  assert.strictEqual(ambiguousRecord.identityConfidence, 'partial');
  assert.strictEqual(ambiguousRecord.captureStatus, 'partial');
  assert.strictEqual(ambiguousRecord.meta.turnBinding, 'ambiguous-open-turns');
  assert.strictEqual((await journalB.getOpenTurns(CCS)).length, 2, 'no turn was closed by guessing');

  // 4. same sessionId in two workspaces never cross-binds.
  const dirC = tempJournalDir();
  const journalC = new Journal(path.join(dirC, 'journal'));
  const ccUser = await journalC.appendConversationEvent(userPrompt({ sessionId: 'shared', repoIdentity: CCS }));
  await journalC.appendConversationEvent(userPrompt({ sessionId: 'shared', repoIdentity: CCB }));
  const ccReply = await journalC.appendConversationEvent(assistant({ sessionId: 'shared', repoIdentity: CCS }));
  assert.strictEqual(ccReply.turnId, ccUser.turnId, 'CCS assistant binds only to the CCS turn');
  const openByWorkspace = await journalC.getOpenTurns(CCB);
  assert.strictEqual(openByWorkspace.length, 1, 'CCB turn stays open — no cross-workspace binding');
  assert.strictEqual((await journalC.getOpenTurns(CCS)).length, 0);

  // 5. restart / full projection rebuild preserves durable identities.
  const rebuilt = new Journal(path.join(dirC, 'journal'));
  const eventsAfterRestart = await rebuilt.readEvents({});
  const ccEvents = eventsAfterRestart.filter((e) => e.repoIdentity && e.repoIdentity.workspaceId === CCS.workspaceId);
  assert.strictEqual(ccEvents[0].turnId, ccUser.turnId);
  assert.strictEqual(ccEvents[1].turnId, ccReply.turnId);
  fs.rmSync(path.join(dirC, 'journal', 'state.json'), { force: true });
  const fullRebuild = new Journal(path.join(dirC, 'journal'));
  const rebuiltEvents = await fullRebuild.readEvents({});
  assert.deepStrictEqual(
    rebuiltEvents.map((e) => [e.sequence, e.turnId]),
    eventsAfterRestart.map((e) => [e.sequence, e.turnId]),
    'full rebuild from events.jsonl keeps identical durable identities'
  );

  // 6. session_end closes remaining open turns without fabricating content.
  const dirD = tempJournalDir();
  const journalD = new Journal(path.join(dirD, 'journal'));
  const dUser = await journalD.appendConversationEvent(userPrompt({ sessionId: 'se' }));
  await journalD.appendConversationEvent({ source: 'claude-code', eventType: 'session_end', sessionId: 'se', repoIdentity: CCS });
  assert.strictEqual((await journalD.getOpenTurns(CCS)).length, 0);
  const state = deriveTurnState(await journalD.readEvents({}));
  assert.strictEqual(state.closedTurns.length, 1);
  assert.strictEqual(state.closedTurns[0].turnId, dUser.turnId);
  assert.strictEqual(state.closedTurns[0].assistantEvents.length, 0, 'no assistant content fabricated by session_end');

  // 7. duplicate eventKey reprocessing is idempotent — no second identity.
  const dirE = tempJournalDir();
  const journalE = new Journal(path.join(dirE, 'journal'));
  const first = await journalE.appendConversationEvent(userPrompt({ sessionId: 'dup', eventKey: 'src-1' }));
  const second = await journalE.appendConversationEvent(userPrompt({ sessionId: 'dup', eventKey: 'src-1', content: 'prompt' }));
  assert.strictEqual(second.duplicate, true);
  assert.strictEqual(second.sequence, first.sequence);
  assert.strictEqual(second.turnId, first.turnId, 'duplicate never mints a new turn id');
  assert.strictEqual((await journalE.readEvents({})).length, 1);
  let rejected = false;
  try {
    await journalE.appendConversationEvent(userPrompt({ sessionId: 'dup', eventKey: '' }));
  } catch (_) {
    rejected = true;
  }
  assert.ok(rejected, 'empty eventKey must be rejected');

  // Synthetic evidence stays forbidden on the canonical path.
  let syntheticRejected = false;
  try {
    await journalE.appendConversationEvent(userPrompt({ sessionId: 'unknown-session' }));
  } catch (_) {
    syntheticRejected = true;
  }
  assert.ok(syntheticRejected, 'unknown-session must be rejected by the canonical append path');

  console.log('journal-turn-identity-test PASS');
}

module.exports = main();
