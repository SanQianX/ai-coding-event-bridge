'use strict';

const assert = require('assert');
const ui = require('..');
const packageInfo = require('../package.json');

assert.strictEqual(ui.packageName, '@sanqianx/ai-coding-event-bridge-ui');
assert.match(ui.version, /^\d+\.\d+\.\d+$/, 'ui version must be semver');
assert.strictEqual(packageInfo.engines.node, '>=18');
for (const component of ['renderProjectDateToolbar', 'renderTurnCard', 'renderVirtualTurnList', 'createConversationExplorer', 'mapCommitAnnotation']) {
  assert.strictEqual(typeof ui[component], 'function', `component export missing: ${component}`);
}
assert.ok(!packageInfo.files.includes('test'), 'tests must not ship in the ui package');

console.log('scaffold-test PASS');
