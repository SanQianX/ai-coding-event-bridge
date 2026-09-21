'use strict';

// F-024: DevTask-Radar used to synthesize '(No captured user prompt for this
// turn)' as fake user text. Synthetic evidence is forbidden anywhere downstream.
const SYNTHETIC_PROMPT_MARKERS = [
  '(no captured user prompt for this turn)',
  '(no user prompt captured)',
  'unknown-session'
];

function isSyntheticPrompt(content) {
  if (typeof content !== 'string') return false;
  const trimmed = content.trim().toLowerCase();
  return SYNTHETIC_PROMPT_MARKERS.includes(trimmed);
}

function orderBySequence(events) {
  return [...events].sort((a, b) => {
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    return String(a.eventId || '').localeCompare(String(b.eventId || ''));
  });
}

function isDuplicateEvent(a, b) {
  if (!a || !b) return false;
  if (a.eventKey && b.eventKey && a.eventKey === b.eventKey) return true;
  return (
    a.source === b.source &&
    a.eventType === b.eventType &&
    (a.sessionId || null) === (b.sessionId || null) &&
    (a.turnId || null) === (b.turnId || null) &&
    a.content === b.content &&
    a.eventId !== undefined &&
    a.eventId === b.eventId
  );
}

/**
 * Deterministic turn projection over ordered events. Mirrors the journal's
 * durable projection: user_prompt opens a turn; assistant_response closes the
 * matching open turn (by turnId, or by sessionId when the client did not
 * provide a turn id). Assistant events that cannot be tied to an open turn are
 * orphan evidence — they are kept, never turned into fake prompts.
 */
function deriveTurnState(events) {
  const ordered = orderBySequence(events.filter((e) => e && typeof e === 'object'));
  const openTurns = new Map();
  const closedTurns = new Map();
  const orphanAssistantEvents = [];

  const findOpenTurnForAssistant = (event) => {
    if (event.turnId && openTurns.has(event.turnId)) return openTurns.get(event.turnId);
    if (event.turnId) return null;
    if (!event.sessionId) return null;
    const matches = [...openTurns.values()].filter((t) => t.sessionId === event.sessionId);
    if (matches.length === 1) return matches[0];
    return null;
  };

  for (const event of ordered) {
    if (event.eventType === 'user_prompt') {
      if (!event.turnId) continue; // unverifiable prompt: identity layer marks it, no fake turn
      if (openTurns.has(event.turnId) || closedTurns.has(event.turnId)) {
        const turn = openTurns.get(event.turnId) || closedTurns.get(event.turnId);
        turn.userEvents.push(event);
        continue;
      }
      openTurns.set(event.turnId, {
        turnId: event.turnId,
        sessionId: event.sessionId || null,
        source: event.source,
        startSequence: event.sequence,
        endSequence: null,
        userEvents: [event],
        assistantEvents: []
      });
      continue;
    }
    if (event.eventType === 'assistant_response') {
      const turn = findOpenTurnForAssistant(event);
      if (!turn) {
        orphanAssistantEvents.push(event);
        continue;
      }
      turn.assistantEvents.push(event);
      turn.endSequence = event.sequence;
      openTurns.delete(turn.turnId);
      closedTurns.set(turn.turnId, turn);
      continue;
    }
    if (event.eventType === 'session_end' && event.sessionId) {
      for (const turn of [...openTurns.values()]) {
        if (turn.sessionId === event.sessionId) {
          turn.endSequence = event.sequence;
          openTurns.delete(turn.turnId);
          closedTurns.set(turn.turnId, turn);
        }
      }
    }
  }

  return {
    openTurns: [...openTurns.values()],
    closedTurns: [...closedTurns.values()],
    orphanAssistantEvents
  };
}

function assertNoSyntheticEvidence(events) {
  for (const event of events) {
    if (event && event.role === 'user' && isSyntheticPrompt(event.content)) {
      throw new Error(`synthetic user prompt is forbidden: ${String(event.content).slice(0, 60)}`);
    }
    if (event && typeof event.sessionId === 'string' && event.sessionId.toLowerCase() === 'unknown-session') {
      throw new Error('unknown-session is forbidden');
    }
  }
  return true;
}

module.exports = {
  isSyntheticPrompt,
  orderBySequence,
  isDuplicateEvent,
  deriveTurnState,
  assertNoSyntheticEvidence
};
