# ai-coding-event-bridge

Durable AI coding event capture bridge for Claude Code, Codex, OpenCode and ZCode,
with atomic Git commit boundaries, multi-consumer cursors, per-project journal
storage and a local conversation console.

## Packages

- `@sanqianx/ai-coding-event-bridge` — core engine (Node >= 18, CommonJS):
  durable journal, atomic `appendEvent()` / `appendCommitBoundary()` under one
  cross-process lock, repo/session/turn identity normalization with no fake
  evidence, per-client connectors and installers, compaction bounded by
  consumer acks, a headless conversation query, a project registry and
  capture-side journal routing.
- `@sanqianx/ai-coding-event-bridge-ui` — framework-neutral mature
  Conversation Explorer (project + date only) with host adapters for data and
  commit annotations.
- `@sanqianx/ai-coding-event-bridge-console` — local console server + page and
  `serve` CLI: import projects (Git work trees) with a chosen local storage
  address, browse conversations per project/date with commit annotations, and
  expose the same query data over a JSON API.

## Quick start (console)

```bash
npm install
npm run serve            # http://127.0.0.1:8790 (localhost-only by default)
```

Import a project from the sidebar (native folder picker on Windows); its
conversations and commit boundaries are then stored under the chosen address
(`<store>/journal`) instead of the global journal. Repos captured before being
imported show up as `auto` entries backed by the global journal, and their
legacy events remain visible after import. Unregistering only removes the
registration — data on disk is never deleted.

## Installers

Installers materialize one per-user runtime (`~/.ai-coding-event-bridge`) and
point Claude/Codex/OpenCode/ZCode managed entries at a stable shim — never into a
host `node_modules`. Multiple consumers (for example project-knowledge and
DevTask-Radar) register themselves; managed hooks are removed only when the
last consumer unregisters. Third-party hooks and configs are always preserved.

## Per-project storage

`projects.json` in the bridge home registers imported projects
(`id` = repo identity workspaceId, `path` = Git work tree root, `store` =
chosen storage root). Capture routes each event to
`<store>/journal` when its repo identity matches a registration, and to the
global `<home>/journal` otherwise — registry failures never block capture.
Consumer-cursor compaction applies to the global journal only; project
journals are archival stores.

## Development

```bash
npm ci
npm test
npm pack --workspace packages/core --dry-run
npm pack --workspace packages/ui --dry-run
npm pack --workspace packages/console --dry-run
```

Releases are published from a protected `workflow_dispatch` bound to an exact
verified commit SHA with npm provenance; this repository creates no Git tags
for package releases.

## License

MIT
