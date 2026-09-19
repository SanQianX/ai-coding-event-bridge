'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync, readJsonIfExists, ensureDirSync } = require('./fs-utils');
const { CrossProcessLock } = require('./lock');
const { resolveRepoContext, comparisonForm } = require('./repo-context');

const REGISTRY_VERSION = 1;

/**
 * Imported-project registry, persisted at `<home>/projects.json`. A registered
 * project owns a durable journal at `<store>/journal`; capture routes events
 * whose repoIdentity.workspaceId matches the project id there instead of the
 * global journal. Removing a project only unregisters it — its data on disk is
 * never touched.
 */

function registryFile(home) {
  return path.join(home, 'projects.json');
}

function registryLockFile(home) {
  return path.join(home, 'locks', 'projects.lock');
}

function loadRegistry(home) {
  const raw = readJsonIfExists(registryFile(home));
  if (!raw || !Array.isArray(raw.projects)) {
    return { version: REGISTRY_VERSION, projects: [] };
  }
  return {
    version: raw.version || REGISTRY_VERSION,
    projects: raw.projects.filter(
      (project) => project && typeof project === 'object' && typeof project.id === 'string' && typeof project.store === 'string'
    )
  };
}

function sameComparisonPath(a, b) {
  return comparisonForm(a) === comparisonForm(b);
}

function defaultStoreFor(home, name) {
  return path.join(home, 'projects', name);
}

async function addProject({ home, path: projectDir, store, resolveRepo = resolveRepoContext } = {}) {
  if (typeof home !== 'string' || !home) {
    throw new Error('addProject requires home');
  }
  if (typeof projectDir !== 'string' || !projectDir.trim()) {
    const err = new Error('addProject requires a project directory');
    err.code = 'PROJECT_PATH_REQUIRED';
    throw err;
  }
  let stat = null;
  try {
    stat = fs.statSync(projectDir);
  } catch (_) {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    const err = new Error(`project directory does not exist: ${projectDir}`);
    err.code = 'PROJECT_DIR_INVALID';
    throw err;
  }

  // The registry only accepts Git work trees: event identity (workspaceId) is
  // derived from the Git toplevel, so a non-Git folder could never match the
  // events captured inside it. Importing a subdirectory resolves to its repo
  // root, which is the identity events actually carry.
  const repo = await resolveRepo(projectDir);
  if (!repo || !repo.repoIdentity) {
    const err = new Error(`not a Git work tree (no repo identity): ${projectDir}`);
    err.code = 'PROJECT_NOT_GIT';
    throw err;
  }

  const name = path.basename(repo.projectPath) || repo.projectPath;
  const entry = {
    id: repo.repoIdentity.workspaceId,
    name,
    path: repo.projectPath,
    remote: repo.repoIdentity.remote || null,
    store: typeof store === 'string' && store.trim() ? path.resolve(store) : defaultStoreFor(home, name),
    createdAt: new Date().toISOString()
  };

  const lock = new CrossProcessLock(registryLockFile(home));
  return lock.withLock(async () => {
    const registry = loadRegistry(home);
    if (registry.projects.some((project) => project.id === entry.id)) {
      const err = new Error(`project already imported: ${entry.path}`);
      err.code = 'PROJECT_DUPLICATE';
      throw err;
    }
    if (registry.projects.some((project) => sameComparisonPath(project.path, entry.path))) {
      const err = new Error(`project path already imported: ${entry.path}`);
      err.code = 'PROJECT_DUPLICATE';
      throw err;
    }
    if (registry.projects.some((project) => sameComparisonPath(project.store, entry.store))) {
      const err = new Error(`store location already used by another project: ${entry.store}`);
      err.code = 'PROJECT_STORE_CONFLICT';
      throw err;
    }
    try {
      ensureDirSync(path.join(entry.store, 'journal'));
    } catch (_) {
      const err = new Error(`cannot create journal directory at: ${entry.store}`);
      err.code = 'PROJECT_STORE_INVALID';
      throw err;
    }
    writeJsonAtomicSync(registryFile(home), {
      version: REGISTRY_VERSION,
      projects: registry.projects.concat([entry])
    });
    return { ...entry };
  });
}

async function removeProject({ home, id } = {}) {
  if (typeof home !== 'string' || !home) {
    throw new Error('removeProject requires home');
  }
  if (typeof id !== 'string' || !id) {
    const err = new Error('removeProject requires a project id');
    err.code = 'PROJECT_ID_REQUIRED';
    throw err;
  }
  const lock = new CrossProcessLock(registryLockFile(home));
  return lock.withLock(async () => {
    const registry = loadRegistry(home);
    let removed = null;
    const projects = [];
    for (const project of registry.projects) {
      if (project.id === id) {
        removed = project;
      } else {
        projects.push(project);
      }
    }
    if (!removed) {
      const err = new Error(`project not registered: ${id}`);
      err.code = 'PROJECT_NOT_FOUND';
      throw err;
    }
    writeJsonAtomicSync(registryFile(home), { version: REGISTRY_VERSION, projects });
    return { ...removed };
  });
}

function listProjects(home) {
  return loadRegistry(home).projects.map((project) => ({ ...project }));
}

module.exports = {
  REGISTRY_VERSION,
  registryFile,
  loadRegistry,
  addProject,
  removeProject,
  listProjects
};
