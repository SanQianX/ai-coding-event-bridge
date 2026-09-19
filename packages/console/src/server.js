'use strict';

const fs = require('fs');
const path = require('path');
const {
  Journal,
  ConversationQuery,
  ConsumerRegistry,
  projectRegistry,
  ensureRuntimeHome,
  semver,
  globalJournalDir,
  projectJournalDir,
  repoIdentityKey
} = require('@sanqianx/ai-coding-event-bridge');
const { pickFolder } = require('./pick-folder');
const { detectAgents } = require('./agent-detect');
const corePackage = require('@sanqianx/ai-coding-event-bridge/package.json');

const BOUNDARY_SCHEMA = 'git-commit-boundary/v1';
const EVENT_SCHEMA = 'ai-coding-event/v1';
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Local console server for the AI coding event bridge. Serves the explorer
 * page plus a JSON API over the bridge journals:
 *
 *   - registered projects (imported via POST /api/projects) own a journal at
 *     <store>/journal and are also merged with their legacy events that still
 *     live in the global journal;
 *   - auto-discovered projects (captured but never imported) read from the
 *     global journal only;
 *   - capture itself is untouched: this process only reads the registry and
 *     the journals, and mutates nothing except projects.json on import.
 */

function localDay(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(raw) {
  try {
    const decoded = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (decoded && decoded.v === 1 && typeof decoded.key === 'string') return decoded;
  } catch (_) {
    // fall through
  }
  return null;
}

function pickFolderEnabled() {
  return process.env.BRIDGE_CONSOLE_PICK_FOLDER !== '0';
}

function createConsoleServer({ home }) {
  if (typeof home !== 'string' || !home) {
    throw new Error('createConsoleServer requires an explicit home directory');
  }
  const globalDir = globalJournalDir(home);
  const consolePageFile = path.join(__dirname, '..', 'console', 'index.html');

  const journals = new Map();
  const queries = new Map();

  function journalAt(dir) {
    let journal = journals.get(dir);
    if (!journal) {
      journal = new Journal(dir);
      journals.set(dir, journal);
    }
    return journal;
  }

  function queryAt(dir) {
    let query = queries.get(dir);
    if (!query) {
      query = new ConversationQuery({ journal: journalAt(dir) });
      queries.set(dir, query);
    }
    return query;
  }

  function existingJournal(dir) {
    return fs.existsSync(dir) ? journalAt(dir) : null;
  }

  function sourcesForProject(project) {
    if (project.auto) {
      return [{ tag: 'global', dir: globalDir }];
    }
    return [
      { tag: 'project', dir: projectJournalDir(project) },
      { tag: 'global', dir: globalDir }
    ];
  }

  function isConversationEvent(record) {
    return record.schema === EVENT_SCHEMA && (record.eventType === 'user_prompt' || record.eventType === 'assistant_response');
  }

  async function allTurnsFrom(query, { project, date }) {
    const turns = [];
    let cursor = null;
    for (;;) {
      const page = await query.turns({ project, date, cursor, limit: 200 });
      turns.push(...page.turns);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return turns;
  }

  function turnSortKey(turn) {
    const at = (turn.userEvents && turn.userEvents[0] && turn.userEvents[0].capturedAt) || '';
    return `${at}|${turn._src || ''}|${turn.turnId || ''}`;
  }

  async function mergedTurns(project, { date }) {
    const merged = [];
    for (const source of sourcesForProject(project)) {
      if (!fs.existsSync(source.dir)) continue;
      const turns = await allTurnsFrom(queryAt(source.dir), { project: project.id, date });
      for (const turn of turns) merged.push({ ...turn, _src: source.tag });
    }
    merged.sort((a, b) => (turnSortKey(a) < turnSortKey(b) ? -1 : turnSortKey(a) > turnSortKey(b) ? 1 : 0));
    return merged;
  }

  async function datesForProject(project) {
    const byDay = new Map();
    for (const source of sourcesForProject(project)) {
      const journal = existingJournal(source.dir);
      if (!journal) continue;
      const records = await journal.readEvents({
        filter: (record) =>
          isConversationEvent(record) && record.eventType === 'user_prompt' && record.turnId && repoIdentityKey(record.repoIdentity) === project.id
      });
      for (const record of records) {
        const day = localDay(record.capturedAt);
        if (!day) continue;
        const turnIds = byDay.get(day) || new Set();
        turnIds.add(record.turnId);
        byDay.set(day, turnIds);
      }
    }
    return [...byDay.entries()]
      .map(([date, turnIds]) => ({ date, turns: turnIds.size }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  function findProject(id) {
    const registered = projectRegistry.listProjects(home).find((project) => project.id === id);
    if (registered) return { ...registered, auto: false };
    return null;
  }

  async function findAutoProject(id) {
    const journal = existingJournal(globalDir);
    if (!journal) return null;
    const discovered = await queryAt(globalDir).listProjects();
    const match = discovered.find((entry) => repoIdentityKey(entry.repoIdentity) === id);
    if (!match) return null;
    const key = repoIdentityKey(match.repoIdentity);
    return {
      id: key,
      name: path.basename(match.projectPath || key) || key,
      path: match.projectPath || null,
      remote: (match.repoIdentity && match.repoIdentity.remote) || null,
      store: globalDir,
      auto: true,
      lastCapturedAt: match.lastCapturedAt || null
    };
  }

  async function resolveProject(id) {
    return (id && (findProject(id) || (await findAutoProject(id)))) || null;
  }

  async function listConsoleProjects() {
    const out = [];
    for (const project of projectRegistry.listProjects(home)) {
      const dates = await datesForProject({ ...project, auto: false });
      const turns = dates.reduce((sum, entry) => sum + entry.turns, 0);
      out.push({
        id: project.id,
        name: project.name,
        path: project.path,
        remote: project.remote || null,
        store: project.store,
        auto: false,
        turns,
        lastCapturedAt: (dates[0] && dates[0].date) || null
      });
    }
    const journal = existingJournal(globalDir);
    if (journal) {
      const registeredIds = new Set(out.map((project) => project.id));
      const discovered = await queryAt(globalDir).listProjects();
      for (const entry of discovered) {
        const key = repoIdentityKey(entry.repoIdentity);
        if (!key || registeredIds.has(key)) continue;
        out.push({
          id: key,
          name: path.basename(entry.projectPath || key) || key,
          path: entry.projectPath || null,
          remote: (entry.repoIdentity && entry.repoIdentity.remote) || null,
          store: globalDir,
          auto: true,
          turns: entry.eventCount,
          lastCapturedAt: entry.lastCapturedAt || null
        });
      }
    }
    return out;
  }

  async function annotationsFor(project, turns) {
    const shasByTurn = new Map();
    const add = (turnId, sha) => {
      if (!turnId) return;
      const set = shasByTurn.get(turnId) || new Set();
      set.add(sha);
      shasByTurn.set(turnId, set);
    };
    for (const source of sourcesForProject(project)) {
      const journal = existingJournal(source.dir);
      if (!journal) continue;
      const boundaries = await journal.readEvents({ filter: (record) => record.schema === BOUNDARY_SCHEMA });
      for (const boundary of boundaries) {
        if (repoIdentityKey(boundary.repoIdentity) !== project.id) continue;
        const sha = typeof boundary.commitSha === 'string' && /^[0-9a-f]{7,40}$/i.test(boundary.commitSha) ? boundary.commitSha : null;
        if (!sha) continue;
        for (const turnId of boundary.openTurnIdsAtCommit || []) add(turnId, sha);
        // Sequence spans only compare within one journal's sequence space.
        for (const turn of turns) {
          if (turn._src !== source.tag) continue;
          if (turn.startSequence <= boundary.sequence && boundary.sequence <= turn.endSequence) add(turn.turnId, sha);
        }
      }
    }
    const annotations = {};
    for (const [turnId, shas] of shasByTurn) {
      annotations[turnId] = { commitShas: [...shas] };
    }
    return annotations;
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  }

  function sendPage(res) {
    let html;
    try {
      html = fs.readFileSync(consolePageFile);
    } catch (_) {
      sendJson(res, 500, { error: { code: 'CONSOLE_PAGE_MISSING', message: `console page not found: ${consolePageFile}` } });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(Object.assign(new Error('request body too large'), { code: 'BODY_TOO_LARGE' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handleApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/health') {
      const journal = existingJournal(globalDir);
      const bounds = journal ? await journal.getBounds() : { firstSequence: 0, lastSequence: 0 };
      sendJson(res, 200, {
        ok: true,
        home,
        registeredProjects: projectRegistry.listProjects(home).length,
        firstSequence: bounds.firstSequence,
        lastSequence: bounds.lastSequence
      });
      return;
    }

    if (route === 'GET /api/system/pick-folder') {
      if (!pickFolderEnabled()) {
        sendJson(res, 501, {
          error: {
            code: 'PICK_FOLDER_UNSUPPORTED',
            message: 'folder picker disabled (BRIDGE_CONSOLE_PICK_FOLDER=0); type the path instead'
          }
        });
        return;
      }
      try {
        const picked = await pickFolder();
        sendJson(res, 200, picked);
      } catch (err) {
        const status = (err && err.status) || 500;
        sendJson(res, status, {
          error: {
            code: status === 501 ? 'PICK_FOLDER_UNSUPPORTED' : 'PICK_FOLDER_FAILED',
            message: (err && err.message) || 'failed to open the folder picker'
          }
        });
      }
      return;
    }

    if (route === 'GET /api/system/agents') {
      const agents = await detectAgents();
      let activeRuntimeVersion = null;
      let runtimeVersions = [];
      const runtimeRoot = path.join(home, 'runtime');
      try {
        const active = JSON.parse(fs.readFileSync(path.join(home, 'active-runtime.json'), 'utf8'));
        if (active && typeof active.version === 'string') activeRuntimeVersion = active.version;
      } catch (_) {
        activeRuntimeVersion = null;
      }
      try {
        runtimeVersions = fs
          .readdirSync(runtimeRoot)
          .filter((name) => fs.statSync(path.join(runtimeRoot, name)).isDirectory())
          .sort();
      } catch (_) {
        runtimeVersions = [];
      }
      let consumers = [];
      try {
        consumers = (await new ConsumerRegistry(home).getConsumers()).map((consumer) => ({
          name: consumer.name,
          lastSeenAt: consumer.lastSeenAt || null,
          notifyUrl: (consumer.meta && consumer.meta.notifyUrl) || null
        }));
      } catch (_) {
        consumers = [];
      }
      sendJson(res, 200, {
        agents,
        bridge: {
          home,
          coreVersion: corePackage.version,
          activeRuntimeVersion,
          runtimeVersions,
          upgradeAvailable: Boolean(activeRuntimeVersion) && semver.compare(activeRuntimeVersion, corePackage.version) === -1
        },
        consumers
      });
      return;
    }

    if (route === 'POST /api/system/upgrade-runtime') {
      try {
        const result = await ensureRuntimeHome({ homeDir: home });
        if (result && result.conflict) {
          sendJson(res, 409, {
            error: {
              code: 'RUNTIME_MAJOR_CONFLICT',
              message: `active runtime ${result.activeVersion} and requested ${result.requestedVersion} differ in major version`
            }
          });
          return;
        }
        sendJson(res, 200, { ok: true, action: result.action, activeVersion: result.activeVersion });
      } catch (err) {
        sendJson(res, 500, { error: { code: 'RUNTIME_UPGRADE_FAILED', message: (err && err.message) || 'upgrade failed' } });
      }
      return;
    }

    if (route === 'GET /api/projects') {
      sendJson(res, 200, { projects: await listConsoleProjects() });
      return;
    }

    if (route === 'POST /api/projects') {
      let parsed = {};
      try {
        parsed = JSON.parse(await readBody(req) || '{}');
      } catch (_) {
        sendJson(res, 400, { error: { code: 'BODY_INVALID', message: 'request body must be JSON' } });
        return;
      }
      try {
        const project = await projectRegistry.addProject({ home, path: parsed.path, store: parsed.store });
        sendJson(res, 201, { project: { ...project, auto: false } });
      } catch (err) {
        const statusByCode = {
          PROJECT_PATH_REQUIRED: 400,
          PROJECT_DIR_INVALID: 400,
          PROJECT_STORE_INVALID: 400,
          PROJECT_NOT_GIT: 422,
          PROJECT_DUPLICATE: 409,
          PROJECT_STORE_CONFLICT: 409
        };
        const status = statusByCode[err && err.code] || 500;
        sendJson(res, status, { error: { code: (err && err.code) || 'INTERNAL', message: err && err.message } });
      }
      return;
    }

    if (route === 'DELETE /api/projects') {
      const id = url.searchParams.get('id');
      try {
        const removed = await projectRegistry.removeProject({ home, id });
        sendJson(res, 200, { removed });
      } catch (err) {
        const status = err && err.code === 'PROJECT_NOT_FOUND' ? 404 : err && err.code === 'PROJECT_ID_REQUIRED' ? 400 : 500;
        sendJson(res, status, { error: { code: (err && err.code) || 'INTERNAL', message: err && err.message } });
      }
      return;
    }

    const projectId = url.searchParams.get('project');
    if (
      route === 'GET /api/dates' ||
      route === 'GET /api/turns' ||
      route === 'GET /api/sessions' ||
      route === 'GET /api/search'
    ) {
      const project = await resolveProject(projectId);
      if (!project) {
        sendJson(res, 404, { error: { code: 'PROJECT_NOT_FOUND', message: `unknown project: ${projectId}` } });
        return;
      }

      if (route === 'GET /api/dates') {
        sendJson(res, 200, { project: project.id, dates: await datesForProject(project) });
        return;
      }

      if (route === 'GET /api/turns') {
        const date = url.searchParams.get('date') || null;
        const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 50, 200));
        const merged = await mergedTurns(project, { date });
        const cursor = url.searchParams.get('cursor');
        let start = 0;
        if (cursor) {
          const decoded = decodeCursor(cursor);
          if (!decoded) {
            sendJson(res, 400, { error: { code: 'CURSOR_INVALID', message: 'cursor is invalid; restart the query' } });
            return;
          }
          start = merged.findIndex((turn) => turnSortKey(turn) > decoded.key);
          if (start === -1) start = merged.length;
        }
        const page = merged.slice(start, start + limit);
        sendJson(res, 200, {
          project: project.id,
          date,
          turns: page,
          nextCursor: start + limit < merged.length ? encodeCursor({ v: 1, key: turnSortKey(merged[start + limit - 1]) }) : null,
          totalTurns: merged.length,
          annotations: await annotationsFor(project, page)
        });
        return;
      }

      if (route === 'GET /api/sessions') {
        const sessions = [];
        for (const source of sourcesForProject(project)) {
          if (!fs.existsSync(source.dir)) continue;
          sessions.push(...(await queryAt(source.dir).listSessions({ project: project.id })));
        }
        sessions.sort((a, b) => b.lastSequence - a.lastSequence);
        sendJson(res, 200, { project: project.id, sessions });
        return;
      }

      if (route === 'GET /api/search') {
        const q = url.searchParams.get('q') || '';
        const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 20, 100));
        const matches = [];
        for (const source of sourcesForProject(project)) {
          if (!fs.existsSync(source.dir)) continue;
          const result = await queryAt(source.dir).searchConversations({ project: project.id, q, limit });
          matches.push(...result.matches.map((match) => ({ ...match, _src: source.tag })));
        }
        matches.sort((a, b) => (a.capturedAt || '') < (b.capturedAt || '') ? 1 : -1);
        sendJson(res, 200, { project: project.id, q, matches: matches.slice(0, limit) });
        return;
      }
    }

    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: route } });
  }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/' || url.pathname === '/index.html') {
        sendPage(res);
        return;
      }
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `${req.method} ${url.pathname}` } });
    } catch (err) {
      sendJson(res, 500, { error: { code: 'INTERNAL', message: (err && err.message) || 'internal error' } });
    }
  };
}

module.exports = { createConsoleServer, localDay };
