'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeClaudeCode, normalizeCodex, normalizeOpenCode } = require('../src/core/normalizer');
const { assertNoSyntheticEvidence } = require('../src/core/turn-identity');

const FIXTURES = path.join(__dirname, 'fixtures');

async function main() {
  const userPrompt = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'claude-code', 'user-prompt-submit.json'), 'utf8'));
  const promptEvent = normalizeClaudeCode(userPrompt);
  assert.strictEqual(promptEvent.eventType, 'user_prompt');
  assert.strictEqual(promptEvent.content, 'Fix the login retry loop');
  assert.strictEqual(promptEvent.sessionId, 'sess-abc');
  assert.match(promptEvent.turnId, /^turn_[0-9a-f-]+$/, 'a real captured prompt owns a fresh turn id');

  const stop = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'claude-code', 'stop.json'), 'utf8'));
  const stopEvent = normalizeClaudeCode(stop);
  assert.strictEqual(stopEvent.eventType, 'assistant_response');
  assert.strictEqual(stopEvent.content, 'Fixed the retry loop in auth.js');
  assert.strictEqual(stopEvent.turnId, null, 'Stop binds to the open turn by session, not a fabricated turn');
  assert.strictEqual(stopEvent.captureStatus, 'complete');

  const codexTurn = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'codex', 'turn.json'), 'utf8'));
  const codexEvent = normalizeCodex(codexTurn);
  assert.strictEqual(codexEvent.source, 'codex');
  assert.strictEqual(codexEvent.role, 'user');
  assert.strictEqual(codexEvent.repoIdentity, 'github.com/acme/widgets');

  const opencodeMsg = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'opencode', 'message.json'), 'utf8'));
  const ocEvent = normalizeOpenCode(opencodeMsg);
  assert.strictEqual(ocEvent.eventType, 'assistant_response');
  assert.strictEqual(ocEvent.content, 'Refactored the parser.');

  // Missing identity degrades explicitly; nothing synthetic is invented.
  const noSession = normalizeClaudeCode({ hookName: 'UserPromptSubmit', prompt: 'hi', cwd: '/repo' });
  assert.strictEqual(noSession.sessionId, null);
  assert.strictEqual(noSession.identityConfidence, 'partial', 'a captured prompt owns its fresh turn id');

  // Stop without an assistant message is not conversation evidence: no event.
  assert.strictEqual(normalizeClaudeCode({ hookName: 'Stop' }), null);
  assert.strictEqual(normalizeClaudeCode({ hookName: 'Stop', session_id: 's1' }), null);

  const noPromptText = normalizeClaudeCode({ hookName: 'UserPromptSubmit', session_id: 's1' });
  assert.strictEqual(noPromptText.content, null, 'missing prompt text stays null');
  assert.strictEqual(noPromptText.captureStatus, 'partial');
  assert.ok(!JSON.stringify(noPromptText).includes('No captured user prompt'));

  const allEvents = [promptEvent, stopEvent, codexEvent, ocEvent, noSession, noPromptText];
  assert.strictEqual(assertNoSyntheticEvidence(allEvents), true);

  assert.strictEqual(normalizeClaudeCode(null), null);
  assert.strictEqual(normalizeClaudeCode({ hookName: 'Other' }), null);
  assert.strictEqual(normalizeCodex({ eventType: 'tool_call' }), null);
  assert.strictEqual(normalizeOpenCode({ type: 'tool' }), null);

  console.log('normalizer-fixtures-test PASS');
}

module.exports = main();
