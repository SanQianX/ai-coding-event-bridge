'use strict';

const assert = require('assert');
const bridge = require('..');
const packageInfo = require('../package.json');

assert.strictEqual(bridge.packageName, '@sanqianx/ai-coding-event-bridge');
assert.match(bridge.version, /^\d+\.\d+\.\d+$/, 'core version must be semver');
assert.strictEqual(packageInfo.engines.node, '>=18', 'core engine floor must stay Node >=18');
assert.deepStrictEqual(packageInfo.files, ['src', 'bin'], 'published files must stay scoped');
assert.ok(Array.isArray(packageInfo.files) && !packageInfo.files.includes('test'), 'tests must not ship in the package');

console.log('scaffold-test PASS');
