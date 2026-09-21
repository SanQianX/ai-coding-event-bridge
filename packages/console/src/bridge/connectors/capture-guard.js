'use strict';

/**
 * Capture-disable guard. Project-Knowledge (or any host) marks its internal
 * AI SDK sessions with AI_CODING_EVENT_BRIDGE_CAPTURE=0 and
 * AI_CODING_EVENT_ORIGIN. Every connector checks this FIRST — before
 * normalization, repo Git resolution, or any journal write — so internal
 * Workbench/Analyzer conversations never reach the durable journal.
 */
function isCaptureDisabled(env = process.env, payload = null) {
  if (env && env.AI_CODING_EVENT_BRIDGE_CAPTURE === '0') {
    return true;
  }
  if (payload && typeof payload === 'object' && payload.meta && typeof payload.meta === 'object') {
    return String(payload.meta.bridgeCapture) === '0';
  }
  return false;
}

function captureDisabledResult() {
  return { status: 'ignored', reason: 'capture-disabled' };
}

module.exports = { isCaptureDisabled, captureDisabledResult };
