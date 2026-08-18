'use strict';

const assert = require('assert');
const { validateAndNormalizeEvent, EventSchemaError, FORBIDDEN_SESSION_IDS } = require('../src/core/event-schema');

function expectSchemaError(fn, field) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof EventSchemaError, `expected EventSchemaError, got ${err}`);
    if (field) assert.strictEqual(err.field, field);
    return;
  }
  throw new Error('expected schema validation to throw');
}

async function main() {
  // Null / partial identity is valid evidence, not an error.
  const nullIdentity = validateAndNormalizeEvent({
    source: 'codex',
    eventType: 'user_prompt',
    role: 'user',
    content: 'help',
    sessionId: null,
    turnId: null
  });
  assert.strictEqual(nullIdentity.identityConfidence, 'unavailable');
  assert.strictEqual(nullIdentity.captureStatus, 'complete');

  const partial = validateAndNormalizeEvent({
    source: 'opencode',
    eventType: 'assistant_response',
    role: 'assistant',
    sessionId: 's-1',
    turnId: null
  });
  assert.strictEqual(partial.identityConfidence, 'partial');

  const exact = validateAndNormalizeEvent({
    source: 'claude-code',
    eventType: 'user_prompt',
    role: 'user',
    sessionId: 's-1',
    turnId: 't-1'
  });
  assert.strictEqual(exact.identityConfidence, 'exact');

  // unknown-session and friends are forbidden outright (AUD-ID-001).
  for (const bad of FORBIDDEN_SESSION_IDS) {
    if (bad === '') continue;
    expectSchemaError(
      () => validateAndNormalizeEvent({ source: 'codex', eventType: 'user_prompt', sessionId: bad }),
      'sessionId'
    );
  }

  // Confidence may never overstate captured evidence.
  const clamped = validateAndNormalizeEvent({
    source: 'codex',
    eventType: 'user_prompt',
    sessionId: null,
    turnId: null,
    identityConfidence: 'exact'
  });
  assert.strictEqual(clamped.identityConfidence, 'unavailable', 'exact without evidence must be clamped');

  expectSchemaError(() => validateAndNormalizeEvent({ source: 'slack', eventType: 'x' }), 'source');
  expectSchemaError(() => validateAndNormalizeEvent({ source: 'codex' }), 'eventType');
  expectSchemaError(() => validateAndNormalizeEvent({ source: 'codex', eventType: 'x', role: 'system' }), 'role');
  expectSchemaError(
    () => validateAndNormalizeEvent({ source: 'codex', eventType: 'x', captureStatus: 'lost' }),
    'captureStatus'
  );

  console.log('event-schema-identity-test PASS');
}

module.exports = main();
