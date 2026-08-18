'use strict';

const { escapeText } = require('./ProjectDateToolbar');

/**
 * Host annotations map frozen commit snapshots to restrained product labels.
 * Internal binding enums (direct / shared-spanning / explicit) never render.
 */
function mapCommitAnnotation(annotation) {
  if (!annotation || typeof annotation !== 'object') return { label: '未提交', shas: [] };
  const shas = (Array.isArray(annotation.commitShas) ? annotation.commitShas : [])
    .filter(sha => typeof sha === 'string' && /^[0-9a-f]{7,40}$/i.test(sha))
    .map(sha => sha.slice(0, 7));
  if (shas.length === 0) return { label: '未提交', shas: [] };
  if (shas.length === 1) return { label: '已提交', shas };
  return { label: '关联提交', shas };
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderTurnCard(turn, annotation) {
  const commit = mapCommitAnnotation(annotation);
  const userText = turn && turn.userEvents && turn.userEvents[0] ? turn.userEvents[0].content : '';
  const assistant = (turn && turn.assistantEvents) || [];
  const time = formatTime(turn && turn.userEvents && turn.userEvents[0] ? turn.userEvents[0].capturedAt : null);
  const commitLine = commit.shas.length
    ? ` · ${commit.shas.join(' · ')}`
    : '';
  return [
    '<article class="turn-card" data-turn-card>',
    `  <time class="turn-time" data-turn-time>${escapeText(time)}</time>`,
    '  <div class="turn-body">',
    `    <div class="turn-user" data-turn-user>${escapeText(userText)}</div>`,
    assistant
      .map(event => `    <div class="turn-assistant" data-turn-assistant>${escapeText(event.content)}</div>`)
      .join('\n'),
    `    <footer class="turn-commit" data-turn-commit>${escapeText(commit.label)}${escapeText(commitLine)}</footer>`,
    '  </div>',
    '</article>'
  ].join('\n');
}

module.exports = { renderTurnCard, mapCommitAnnotation, formatTime };
