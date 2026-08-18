'use strict';

const packageInfo = require('../package.json');
const { renderProjectDateToolbar } = require('./ProjectDateToolbar');
const { renderTurnCard, mapCommitAnnotation } = require('./TurnCard');
const { renderVirtualTurnList } = require('./VirtualTurnList');
const { createConversationExplorer } = require('./host-adapter');

module.exports = {
  packageName: packageInfo.name,
  version: packageInfo.version,
  renderProjectDateToolbar,
  renderTurnCard,
  mapCommitAnnotation,
  renderVirtualTurnList,
  createConversationExplorer
};
