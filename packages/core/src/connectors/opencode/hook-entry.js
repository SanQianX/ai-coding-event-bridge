'use strict';

const path = require('path');
const { Journal } = require('../../core/journal');
const { validateAndNormalizeEvent } = require('../../core/event-schema');
const { resolveRepoContext } = require('../../core/repo-context');
const { notifyConsumers } = require('../claude-code/notify');

/**
 * OpenCode plugin capture. The plugin ships the native event to the stable
 * shim; capture is a local durable append first. There is no HTTP endpoint
 * dependency (the legacy 127.0.0.1:8787 coupling is gone) — consumer wake-up
 * uses the generic best-effort notify channel only.
 */
async function main({ home, payload }) {
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
    turnId: isUser ? payload.turnId || null : payload.turnId || null,
    repoIdentity: repo.repoIdentity,
    projectPath: repo.projectPath,
    branch: repo.branch,
    headAtCapture: repo.headAtCapture,
    identityConfidence: payload.sessionId ? (payload.turnId ? 'exact' : 'partial') : 'unavailable',
    captureStatus: typeof payload.text === 'string' ? 'complete' : 'partial',
    rawEventType: payload.type
  });
  const appended = await journal.appendEvent(event);
  await notifyConsumers(home, { source: 'opencode', sequence: appended.sequence, eventId: appended.eventId });
  return { status: 'captured', sequence: appended.sequence };
}

function mainFailOpen({ home, payload }) {
  return main({ home, payload }).catch(() => ({ status: 'fail-open' }));
}

module.exports = { main, mainFailOpen };
