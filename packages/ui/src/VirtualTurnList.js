'use strict';

const { renderTurnCard } = require('./TurnCard');
const { escapeText } = require('./ProjectDateToolbar');

/**
 * Windowed turn list: renders a slice of turns plus a sentinel so hosts can
 * implement virtualized scrolling. Long histories are never rendered whole.
 */
function renderVirtualTurnList({ turns = [], offset = 0, windowSize = 40, annotations = {} } = {}) {
  const page = turns.slice(offset, offset + windowSize);
  const remaining = Math.max(0, turns.length - (offset + page.length));
  const cards = page
    .map(turn => renderTurnCard(turn, annotations[turn.turnId]))
    .join('\n');
  const sentinel = remaining > 0 ? `<div class="turn-window-sentinel" data-remaining="${remaining}"></div>` : '';
  const empty =
    turns.length === 0
      ? '<div class="turn-empty" data-turn-empty>这一天没有开发对话。</div>'
      : '';
  return [
    `<div class="turn-list" data-turn-list data-offset="${offset}" data-total="${escapeText(turns.length)}">`,
    cards,
    sentinel,
    empty,
    '</div>'
  ]
    .filter(Boolean)
    .join('\n');
}

module.exports = { renderVirtualTurnList };
