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

Or from npm — every package publishes a command named after itself (npm's
default bin rule, scope stripped):

```bash
npm install -g @sanqianx/ai-coding-event-bridge-console
ai-coding-event-bridge-console serve      # http://127.0.0.1:8790

# or, without installing:
npx @sanqianx/ai-coding-event-bridge-console serve
```

Installing the core package instead gives you the `ai-coding-event-bridge`
dispatcher, which can also start the console when the console package is
present (`ai-coding-event-bridge serve`) and inject commit boundaries
(`ai-coding-event-bridge commit-boundary --cwd <repo>`).

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
journals are archival stores. The recommended store layout is
`knowledge/<project>/dev-conversations` (see "Commit sealing" below).

## Commit sealing

When a commit boundary lands in a registered project's journal, the bridge
freezes that commit's conversations into a human-readable Markdown file at
`<store>/commits/<full-sha>.md` (YAML frontmatter with commit facts and a
provenance `contentHash`, then per-turn 用户/助手 bodies). Turns still open
at commit time are included — the user's ask is the requirement truth for
that commit; a reply that arrives after the commit seals into the next file
as an 未配对事件 appendix, so no conversation body is ever dropped.
Commits without conversations produce no file; amending produces a new file
and leaves the old one as immutable evidence. Sealing is a rebuildable
projection: `commitProjection.rebuildSealedFiles()` recreates any missing
file from the journal, and a sealing failure never fails the boundary
append (it is reported in `appendCommitBoundary(...).projection`).

Hosts signal commits through the facade (`appendCommitBoundary`) or the CLI:

```bash
node packages/core/src/bin/commit-boundary.js --cwd <repo> [--home <bridge home>]
# equivalently, once @sanqianx/ai-coding-event-bridge is installed:
ai-coding-event-bridge commit-boundary --cwd <repo> [--home <bridge home>]
```

The CLI resolves the repo identity from the working tree, reads HEAD facts
from git, and prints one JSON line — designed to be called from a managed
git post-commit hook. `node packages/core/examples/seal-demo.js` demos the
whole flow standalone.

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
