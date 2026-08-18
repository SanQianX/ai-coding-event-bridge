'use strict';

/**
 * Host adapter contract.
 *
 * ConversationDataProvider (required): {
 *   listProjects(): Promise<Array<{ id, label }>>,
 *   turns({ project, date, cursor, limit }): Promise<{ turns, nextCursor, totalTurns }>
 * }
 *
 * CommitAnnotationProvider (optional): {
 *   annotationFor(turn): { commitShas: string[] } | null
 * }
 *
 * The Explorer never reads host databases, JSONL files or Bridge internals;
 * it renders only what these two adapters return.
 */
function createConversationExplorer({ dataProvider, annotationProvider = null } = {}) {
  if (!dataProvider || typeof dataProvider.listProjects !== 'function' || typeof dataProvider.turns !== 'function') {
    throw new Error('ConversationExplorer requires a ConversationDataProvider');
  }
  let state = { project: '', date: today(), cursor: null, turns: [], annotations: {} };
  let render = () => {};

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  async function load() {
    const page = await dataProvider.turns({
      project: state.project,
      date: state.date,
      cursor: state.cursor,
      limit: 40
    });
    state.turns = state.cursor ? state.turns.concat(page.turns) : page.turns;
    state.cursor = page.nextCursor || null;
    if (annotationProvider && typeof annotationProvider.annotationFor === 'function') {
      for (const turn of page.turns) {
        state.annotations[turn.turnId] = annotationProvider.annotationFor(turn);
      }
    }
    render(state);
    return state;
  }

  return {
    setRenderer(fn) {
      render = typeof fn === 'function' ? fn : () => {};
    },
    async init(defaultProject = '') {
      const projects = await dataProvider.listProjects();
      state.project = defaultProject || (projects[0] ? projects[0].id : '');
      await load();
      return projects;
    },
    async selectProject(projectId) {
      state.project = projectId;
      state.cursor = null;
      state.annotations = {};
      await load();
    },
    async selectDate(date) {
      state.date = date;
      state.cursor = null;
      await load();
    },
    async loadMore() {
      if (!state.cursor) return state;
      await load();
      return state;
    },
    getState() {
      return { ...state, annotations: { ...state.annotations } };
    }
  };
}

module.exports = { createConversationExplorer };
