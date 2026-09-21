'use strict';

const { randomUUID } = require('crypto');
const { validateAndNormalizeEvent } = require('./event-schema');

function assignTurnIdForPrompt() {
  // A real captured user prompt owns a fresh turn identity. This is identity
  // assignment for captured evidence, never content fabrication.
  return `turn_${randomUUID()}`;
}

/**
 * Claude Code hook payload -> normalized event.
 * Claude Code ships the event name as hook_event_name; hookName/hook_name
 * variants are accepted for compatibility. UserPromptSubmit carries the exact
 * user prompt; Stop yields an assistant_response only when
 * last_assistant_message exists — an empty Stop is not conversation evidence
 * and produces no event. Turn closure binding happens in the journal's
 * canonical append path.
 */
function hookEventName(raw) {
  return raw.hook_event_name || raw.hookName || raw.hook_name || null;
}

function normalizeClaudeCode(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const base = { source: 'claude-code' };
  if (hookEventName(raw) === 'UserPromptSubmit' || raw.eventType === 'user_prompt') {
    const content = typeof raw.prompt === 'string' ? raw.prompt : null;
    const event = {
      ...base,
      eventType: 'user_prompt',
      role: 'user',
      content,
      sessionId: raw.session_id || null,
      turnId: raw.turnId || assignTurnIdForPrompt(),
      repoIdentity: raw.repoIdentity,
      projectPath: raw.cwd,
      identityConfidence: content === null ? 'partial' : 'exact',
      captureStatus: content === null ? 'partial' : 'complete',
      rawEventType: hookEventName(raw) || 'user_prompt'
    };
    return validateAndNormalizeEvent(event);
  }
  if (hookEventName(raw) === 'Stop' || raw.eventType === 'assistant_response') {
    if (typeof raw.last_assistant_message !== 'string' || !raw.last_assistant_message) {
      return null;
    }
    return validateAndNormalizeEvent({
      ...base,
      eventType: 'assistant_response',
      role: 'assistant',
      content: raw.last_assistant_message,
      sessionId: raw.session_id || null,
      turnId: raw.turnId || null,
      repoIdentity: raw.repoIdentity,
      projectPath: raw.cwd,
      identityConfidence: 'partial',
      captureStatus: 'complete',
      rawEventType: hookEventName(raw) || 'assistant_response'
    });
  }
  return null;
}

/**
 * Codex events arrive via notify + session parsing (BR05 owns the parser).
 * The normalizer only maps a parsed turn record to the standard event shape.
 */
function normalizeCodex(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.eventType === 'user_prompt' || raw.eventType === 'assistant_response') {
    return validateAndNormalizeEvent({
      source: 'codex',
      eventType: raw.eventType,
      role: raw.eventType === 'user_prompt' ? 'user' : 'assistant',
      content: typeof raw.content === 'string' ? raw.content : null,
      sessionId: raw.sessionId || null,
      turnId: raw.turnId || (raw.eventType === 'user_prompt' ? assignTurnIdForPrompt() : null),
      repoIdentity: raw.repoIdentity,
      projectPath: raw.projectPath || raw.cwd,
      identityConfidence: raw.identityConfidence,
      captureStatus: raw.captureStatus,
      rawEventType: raw.rawEventType
    });
  }
  return null;
}

/**
 * OpenCode plugin events: user/assistant lifecycle from the official plugin.
 */
function normalizeOpenCode(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type === 'user' || raw.type === 'assistant') {
    const isUser = raw.type === 'user';
    return validateAndNormalizeEvent({
      source: 'opencode',
      eventType: isUser ? 'user_prompt' : 'assistant_response',
      role: isUser ? 'user' : 'assistant',
      content: typeof raw.text === 'string' ? raw.text : null,
      sessionId: raw.sessionId || null,
      turnId: isUser ? (raw.turnId || assignTurnIdForPrompt()) : raw.turnId || null,
      repoIdentity: raw.repoIdentity,
      projectPath: raw.cwd || raw.projectPath,
      identityConfidence: raw.identityConfidence,
      captureStatus: raw.captureStatus,
      rawEventType: raw.type
    });
  }
  return null;
}

module.exports = { normalizeClaudeCode, normalizeCodex, normalizeOpenCode };
