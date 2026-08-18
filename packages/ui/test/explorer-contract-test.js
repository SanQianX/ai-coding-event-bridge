'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ui = require('..');

const FORBIDDEN_CONTROLS = ['来源', '全部来源', 'Session', 'sessionId', '搜索', '时间线', 'commit 视角', 'shared-spanning', 'bindingKind'];

async function main() {
  // DOM contract: the toolbar carries exactly a project select and a date input.
  const toolbar = ui.renderProjectDateToolbar({
    projects: [{ id: 'github.com/acme/widgets', label: 'widgets' }, { id: 'github.com/acme/radar', label: 'radar' }],
    selectedProject: 'github.com/acme/widgets',
    selectedDate: '2026-08-18'
  });
  assert.strictEqual((toolbar.match(/<select/g) || []).length, 1, 'exactly one project selector');
  assert.strictEqual((toolbar.match(/type="date"/g) || []).length, 1, 'exactly one date picker');
  assert(!toolbar.includes('全部项目'), 'no all-projects option');
  for (const forbidden of FORBIDDEN_CONTROLS) {
    assert(!toolbar.includes(forbidden), `toolbar must not contain: ${forbidden}`);
  }

  // Turn card: time, user text, assistant reply, restrained commit labels.
  const card = ui.renderTurnCard(
    {
      turnId: 't-1',
      userEvents: [{ content: '修复登录重试循环 https://example.com/a/very/long/path/that/must/wrap', capturedAt: '2026-08-18T09:05:00.000Z' }],
      assistantEvents: [{ content: '已修复 auth.js 中的重试。' }]
    },
    { commitShas: ['1a2b3c4d5e6f7890a1b2c3d4e5f60718'] }
  );
  assert(card.includes('data-turn-user'));
  assert(card.includes('已修复 auth.js'));
  assert(card.includes('已提交 · 1a2b3c4'), 'single commit renders 已提交 + short sha');
  assert(!card.includes('direct'), 'internal binding enums never render');

  const spanning = ui.renderTurnCard(
    { turnId: 't-2', userEvents: [{ content: 'q', capturedAt: '2026-08-18T10:00:00.000Z' }], assistantEvents: [] },
    { commitShas: ['1a2b3c4d5e6f7890a1b2c3d4e5f60718', '9f8e7d6c5b4a392817065544332211ff'] }
  );
  assert(spanning.includes('关联提交 · 1a2b3c4 · 9f8e7d6'), 'multi-commit turn renders 关联提交 with each short sha');

  const uncommitted = ui.renderTurnCard(
    { turnId: 't-3', userEvents: [{ content: '未提交的问题', capturedAt: '2026-08-18T11:00:00.000Z' }], assistantEvents: [] },
    null
  );
  assert(uncommitted.includes('未提交'));

  // Annotation mapping sanitizes invalid shas instead of rendering them.
  assert.deepStrictEqual(ui.mapCommitAnnotation({ commitShas: ['not-a-sha'] }), { label: '未提交', shas: [] });

  // Long text wraps (CSS class contract) and never breaks layout horizontally.
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'conversation-explorer.css'), 'utf8');
  assert(css.includes('overflow-wrap: anywhere'), 'long paths must wrap');
  assert(css.includes('prefers-color-scheme: dark') && css.includes('[data-theme="dark"]'), 'dark theme required');
  assert(css.includes('max-width: 430px'), '390x844-class mobile layout required');

  // Virtual list: windowed rendering with sentinel and empty state.
  const turns = Array.from({ length: 100 }, (_, i) => ({
    turnId: `t-${i}`,
    userEvents: [{ content: `prompt ${i}`, capturedAt: '2026-08-18T09:00:00.000Z' }],
    assistantEvents: []
  }));
  const windowed = ui.renderVirtualTurnList({ turns, offset: 0, windowSize: 40 });
  assert.strictEqual((windowed.match(/data-turn-card/g) || []).length, 40, 'only the window renders');
  assert(windowed.includes('data-remaining="60"'), 'sentinel reports the remainder');
  const empty = ui.renderVirtualTurnList({ turns: [] });
  assert(empty.includes('data-turn-empty'), 'empty state renders a restrained notice');

  // Host adapter: explorer state machine over provider data.
  const pages = [
    { turns: turns.slice(0, 40), nextCursor: 'c2', totalTurns: 100 },
    { turns: turns.slice(40, 80), nextCursor: null, totalTurns: 100 }
  ];
  let call = 0;
  const explorer = ui.createConversationExplorer({
    dataProvider: {
      listProjects: async () => [{ id: 'p1', label: 'One' }],
      turns: async () => (pages[call] ? pages[call++] : { turns: [], nextCursor: null, totalTurns: 0 })
    },
    annotationProvider: { annotationFor: turn => (turn.turnId === 't-0' ? { commitShas: ['1a2b3c4d5e6f7890a1b2c3d4e5f60718'] } : null) }
  });
  await explorer.init();
  let state = explorer.getState();
  assert.strictEqual(state.turns.length, 40);
  assert.strictEqual(state.cursor, 'c2');
  assert(state.annotations['t-0'].commitShas.length === 1);
  await explorer.loadMore();
  state = explorer.getState();
  assert.strictEqual(state.turns.length, 80);
  assert.strictEqual(state.cursor, null);
  await explorer.selectDate('2026-08-19');
  assert.strictEqual(explorer.getState().turns.length, 0, 'date change reloads from scratch');

  let threw = false;
  try {
    ui.createConversationExplorer({ dataProvider: {} });
  } catch (_) {
    threw = true;
  }
  assert.ok(threw, 'missing provider contract fails fast');

  console.log('explorer-contract-test PASS');
}

module.exports = main();
