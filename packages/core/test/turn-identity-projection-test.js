'use strict';

const assert = require('assert');
const {
  deriveTurnState,
  orderBySequence,
  isDuplicateEvent,
  isSyntheticPrompt,
  assertNoSyntheticEvidence
} = require('../src/core/turn-identity');

function ev(sequence, eventType, extra = {}) {
  return { sequence, eventId: `e${sequence}`, eventType, ...extra };
}

async function main() {
  // Open turn projection with session-bound assistant closure.
  const events = [
    ev(1, 'user_prompt', { role: 'user', turnId: 't1', sessionId: 's1', content: 'first' }),
    ev(2, 'user_prompt', { role: 'user', turnId: 't2', sessionId: 's2', content: 'second' }),
    ev(3, 'assistant_response', { role: 'assistant', turnId: null, sessionId: 's1', content: 'reply to first' })
  ];
  const state = deriveTurnState(events);
  assert.deepStrictEqual(
    state.openTurns.map((t) => t.turnId),
    ['t2'],
    'assistant closes the single open turn of its session'
  );
  assert.strictEqual(state.closedTurns.length, 1);
  assert.strictEqual(state.closedTurns[0].turnId, 't1');
  assert.strictEqual(state.closedTurns[0].endSequence, 3);

  // Ambiguous session closure (two open turns, no turnId) leaves both open.
  const ambiguous = deriveTurnState([
    ev(1, 'user_prompt', { turnId: 'a', sessionId: 'sx', content: '1' }),
    ev(2, 'user_prompt', { turnId: 'b', sessionId: 'sx', content: '2' }),
    ev(3, 'assistant_response', { sessionId: 'sx', content: 'r' })
  ]);
  assert.strictEqual(ambiguous.openTurns.length, 2, 'ambiguous binding must not guess');

  // Late assistant after the prompt still belongs to the same turn as tail.
  const tail = deriveTurnState([
    ev(1, 'user_prompt', { turnId: 't1', sessionId: 's1', content: 'q' }),
    ev(2, 'assistant_response', { turnId: 't1', sessionId: 's1', content: 'a1' }),
    ev(3, 'assistant_response', { turnId: 't1', sessionId: 's1', content: 'a2-late' })
  ]);
  assert.strictEqual(tail.closedTurns.length, 1);
  assert.strictEqual(tail.closedTurns[0].assistantEvents.length, 1);
  assert.strictEqual(tail.orphanAssistantEvents.length, 1, 'post-close assistant stays orphan evidence');

  // session_end closes the session's remaining open turns.
  const ended = deriveTurnState([
    ev(1, 'user_prompt', { turnId: 't1', sessionId: 's1', content: 'q' }),
    ev(2, 'session_end', { sessionId: 's1' })
  ]);
  assert.strictEqual(ended.openTurns.length, 0);
  assert.strictEqual(ended.closedTurns.length, 1);

  // Duplicate detection and reordering.
  const a = { eventKey: 'k-1', source: 'codex', eventType: 'user_prompt', sessionId: 's', turnId: 't', content: 'x' };
  const b = { eventKey: 'k-1', source: 'codex', eventType: 'user_prompt', sessionId: 's', turnId: 't', content: 'x' };
  const c = { ...a, eventKey: 'k-2' };
  assert.strictEqual(isDuplicateEvent(a, b), true);
  assert.strictEqual(isDuplicateEvent(a, c), false);
  const reordered = orderBySequence([ev(3, 'x'), ev(1, 'x'), ev(2, 'x')]);
  assert.deepStrictEqual(
    reordered.map((e) => e.sequence),
    [1, 2, 3],
    'arrival disorder must not change durable order'
  );

  // No synthetic evidence anywhere.
  assert.strictEqual(isSyntheticPrompt('(No captured user prompt for this turn)'), true);
  assert.strictEqual(isSyntheticPrompt('real requirement'), false);
  let threw = false;
  try {
    assertNoSyntheticEvidence([ev(1, 'user_prompt', { role: 'user', content: '(No captured user prompt for this turn)' })]);
  } catch (_) {
    threw = true;
  }
  assert.ok(threw, 'synthetic prompts must be rejected');

  console.log('turn-identity-projection-test PASS');
}

module.exports = main();
