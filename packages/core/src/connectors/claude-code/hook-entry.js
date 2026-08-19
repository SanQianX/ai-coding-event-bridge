'use strict';

const path = require('path');
const { Journal } = require('../../core/journal');
const { normalizeClaudeCode } = require('../../core/normalizer');
const { resolveRepoContext } = require('../../core/repo-context');
const { isCaptureDisabled, captureDisabledResult } = require('../capture-guard');
const { notifyConsumers } = require('./notify');

/**
 * Durable-first Claude Code hook processing. The event is appended and fsynced
 * to the Bridge journal before any consumer notification is attempted, and the
 * whole entry fails open: a broken Bridge must never block the AI client.
 * Internal host SDK sessions (AI_CODING_EVENT_BRIDGE_CAPTURE=0) are ignored
 * before any Git/journal work happens.
 */
async function main({ home, payload }) {
  if (isCaptureDisabled(process.env, payload)) {
    return captureDisabledResult();
  }
  if (!payload || typeof payload !== 'object') {
    return { status: 'ignored' };
  }
  const event = normalizeClaudeCode(payload);
  if (!event) {
    return { status: 'ignored' };
  }
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const repo = await resolveRepoContext(cwd);
  const journal = new Journal(path.join(home, 'journal'));
  const appended = await journal.appendConversationEvent({
    ...event,
    repoIdentity: event.repoIdentity || repo.repoIdentity,
    projectPath: event.projectPath || repo.projectPath,
    branch: event.branch || repo.branch,
    headAtCapture: event.headAtCapture || repo.headAtCapture
  });
  await notifyConsumers(home, { sequence: appended.sequence, eventId: appended.eventId });
  return { status: 'captured', sequence: appended.sequence, turnId: appended.turnId };
}

function mainFailOpen({ home, payload }) {
  return main({ home, payload }).catch(() => ({ status: 'fail-open' }));
}

module.exports = { main, mainFailOpen };
