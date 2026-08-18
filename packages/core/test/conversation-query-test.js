'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureRuntimeHome } = require('../src/core/runtime-home');
const { Journal } = require('../src/core/journal');
const { ConversationQuery } = require('../src/query/conversation-query');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-query-'));

async function main() {
  await ensureRuntimeHome({ homeDir: HOME, version: '0.1.0' });
  const journal = new Journal(path.join(HOME, 'journal'));

  // Two projects, multiple days, large history window.
  for (let i = 1; i <= 120; i++) {
    const project = i % 2 === 0 ? 'github.com/acme/even' : 'github.com/acme/odd';
    const day = i <= 60 ? '2026-08-17' : '2026-08-18';
    const hour = String((i % 5) + 2).padStart(2, '0');
    await journal.appendEvent({
      source: 'claude-code',
      eventType: 'user_prompt',
      role: 'user',
      content: `even-project requirement ${i} with keyword alpha-${i % 10}`,
      repoIdentity: project,
      sessionId: `s-${day}-${i % 2}`,
      turnId: `t-${i}`,
      capturedAt: `${day}T${hour}:00:00.000Z`
    });
    if (i % 3 === 0) {
      await journal.appendEvent({
        source: 'claude-code',
        eventType: 'assistant_response',
        role: 'assistant',
        content: `reply ${i}`,
        repoIdentity: project,
        sessionId: `s-${day}-${i % 2}`,
        turnId: `t-${i}`,
        capturedAt: `${day}T${hour}:30:00.000Z`
      });
    }
  }

  const query = new ConversationQuery({ journal });

  const projects = await query.listProjects();
  assert.deepStrictEqual(projects.map(p => p.repoIdentity).sort(), ['github.com/acme/even', 'github.com/acme/odd']);
  assert.ok(projects.every(p => p.eventCount > 0 && p.sources.includes('claude-code')));

  // Multi-project/date queries.
  const odd17 = await query.turns({ project: 'github.com/acme/odd', date: '2026-08-17' });
  assert.strictEqual(odd17.totalTurns, 30);
  assert.ok(odd17.turns.every(t => t.repoIdentity === 'github.com/acme/odd'));
  assert.ok(odd17.turns.every(t => t.userEvents.length === 1));

  // Cursor pagination walks the whole window without duplicates or gaps.
  const seen = [];
  let cursor = null;
  for (;;) {
    const page = await query.turns({ project: 'github.com/acme/odd', date: '2026-08-17', cursor, limit: 7 });
    seen.push(...page.turns.map(t => t.startSequence));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.strictEqual(seen.length, 30);
  assert.deepStrictEqual(seen, [...seen].sort((a, b) => a - b));
  assert.strictEqual(new Set(seen).size, 30, 'no duplicated turns across pages');

  // Assistant tail attaches to its turn.
  const withReply = odd17.turns.find(t => t.assistantEvents.length === 1);
  assert(withReply, 'assistant replies are surfaced inside their turns');

  // Search spans the controlled body text only through the business query.
  const matches = await query.searchConversations({ q: 'alpha-3' });
  assert(matches.matches.length >= 12);
  assert(matches.matches.every(m => m.content.includes('alpha-3')));

  // Privacy projection: bodies are present (controlled query), journal
  // internals and cursor payloads are not leaked into records.
  const raw = JSON.stringify(odd17.turns[0]);
  assert(raw.includes('requirement'));
  assert(!raw.includes('"meta"'), 'journal internal metadata stays private');
  let threw = false;
  try {
    await query.turns({ cursor: 'not-a-cursor' });
  } catch (err) {
    threw = err.code === 'LOG_CURSOR_EXPIRED';
  }
  assert.ok(threw, 'invalid cursors fail typed');

  // Session inventory per project.
  const sessions = await query.listSessions({ project: 'github.com/acme/even' });
  assert(sessions.length > 0);
  assert(sessions.every(s => s.repoIdentity === 'github.com/acme/even'));

  console.log('conversation-query-test PASS');
}

module.exports = main();
