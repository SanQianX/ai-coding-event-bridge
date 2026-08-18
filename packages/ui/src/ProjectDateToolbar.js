'use strict';

/**
 * The mature Explorer toolbar exposes EXACTLY two controls: one project
 * selector and one date picker. No source, session, search or view-mode
 * controls may ever appear here.
 */
function renderProjectDateToolbar(options = {}) {
  const projects = Array.isArray(options.projects) ? options.projects : [];
  const selected = String(options.selectedProject || '');
  const date = String(options.selectedDate || '');
  const projectOptions = projects
    .map(
      project =>
        `<option value="${escapeAttr(project.id)}"${project.id === selected ? ' selected' : ''}>${escapeText(project.label)}</option>`
    )
    .join('');
  return [
    '<div class="conversation-toolbar" data-conversation-toolbar>',
    '  <label class="field">',
    '    <span>项目</span>',
    `    <select class="conversation-project" data-conversation-project>${projectOptions}</select>`,
    '  </label>',
    '  <label class="field">',
    '    <span>日期</span>',
    `    <input class="conversation-date" data-conversation-date type="date" value="${escapeAttr(date)}">`,
    '  </label>',
    '</div>'
  ].join('\n');
}

function escapeText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return escapeText(value).replace(/"/g, '&quot;');
}

module.exports = { renderProjectDateToolbar, escapeText, escapeAttr };
