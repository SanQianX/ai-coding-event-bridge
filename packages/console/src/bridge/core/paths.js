'use strict';

const os = require('os');
const path = require('path');

function bridgeHome(explicit) {
  if (explicit) return explicit;
  if (process.env.AI_CODING_EVENT_BRIDGE_HOME) return process.env.AI_CODING_EVENT_BRIDGE_HOME;
  return path.join(os.homedir(), '.ai-coding-event-bridge');
}

module.exports = { bridgeHome };
