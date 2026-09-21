'use strict';

const assert = require('assert');
const bridge = require('../src/bridge');
const packageInfo = require('../package.json');

assert.strictEqual(bridge.packageName, '@sanqianx/ai-coding-event-bridge-console');
assert.match(bridge.version, /^\d+\.\d+\.\d+$/, 'bridge version must be semver');
assert.strictEqual(packageInfo.engines.node, '>=18', 'engine floor must stay Node >=18');
assert.ok(Array.isArray(packageInfo.files) && !packageInfo.files.includes('test'), 'tests must not ship in the package');

console.log('scaffold-test PASS');
