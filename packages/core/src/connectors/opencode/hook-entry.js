'use strict';

const path = require('path');
const { Journal } = require('../../core/journal');
const { validateAndNormalizeEvent } = require('../../core/event-schema');
const { resolveRepoContext } = require('../../core/repo-context');
const { isCaptureDisabled, captureDisabledResult } = require('../capture-guard');
const { notifyConsumers } = require('../claude-code/notify');

/**
 * OpenCode plugin capture. The plugin ships the native event to the stable
 * shim; capture is a local durable append first via the canonical
 * conversation path (Bridge-owned turn identity). There is no HTTP endpoint
 * dependency — consumer wake-up uses the generic best-effort notify channel
 * only. Capture-disable is checked before any repo/journal work.
 */
async function main({ home, payload }) {
  if (isCaptureDisabled(process.env, payload)) {
    return captureDisabledResult();
  }
  if (!payload || typeof payload !== 'object') {
    return { status: 'ignored' };
  }
  if (payload.type !== 'user' && payload.type !== 'assistant') {
    // Tool/file/todo lifecycle events stay out of the conversation truth.
    return { status: 'ignored' };
  }
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const repo = await resolveRepoContext(cwd);
  const journal = new Journal(path.join(home, 'journal'));
  const isUser = payload.type === 'user';
  const event = validateAndNormalizeEvent({
    source: 'opencode',
    eventType: isUser ? 'user_prompt' : 'assistant_response',
    role: isUser ? 'user' : 'assistant',
    content: typeof payload.text === 'string' ? payload.text : null,
    sessionId: payload.sessionId || payload.session_id || null,
    turnId: payload.turnId || null,
    repoIdentity: repo.repoIdentity,
    projectPath: repo.projectPath,
    branch: repo.branch,
    headAtCapture: repo.headAtCapture,
    identityConfidence: payload.sessionId ? (payload.turnId ? 'exact' : 'partial') : 'unavailable',
    captureStatus: typeof payload.text === 'string' ? 'complete' : 'partial',
    rawEventType: payload.type
  });
  const appended = await journal.appendConversationEvent(event);
  await notifyConsumers(home, { source: 'opencode', sequence: appended.sequence, eventId: appended.eventId });
  return { status: 'captured', sequence: appended.sequence, turnId: appended.turnId };
}

function mainFailOpen({ home, payload }) {
  return main({ home, payload }).catch(() => ({ status: 'fail-open' }));
}

module.exports = { main, mainFailOpen };
