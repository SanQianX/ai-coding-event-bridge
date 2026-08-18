'use strict';

const assert = require('assert');
const ui = require('..');
const packageInfo = require('../package.json');

assert.strictEqual(ui.packageName, '@sanqianx/ai-coding-event-bridge-ui');
assert.match(ui.version, /^\d+\.\d+\.\d+$/, 'ui version must be semver');
assert.strictEqual(packageInfo.engines.node, '>=18');
assert.deepStrictEqual(ui.components, {}, 'components arrive with the explorer commit');
assert.ok(!packageInfo.files.includes('test'), 'tests must not ship in the ui package');

console.log('scaffold-test PASS');
