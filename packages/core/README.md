# @sanqianx/ai-coding-event-bridge

Durable AI coding event capture bridge core for Claude Code, Codex,
OpenCode and ZCode: journal with atomic `appendEvent()` / `appendCommitBoundary()`,
identity normalization without fake evidence, per-client connectors and
installers, consumer-cursor-bounded compaction, a headless conversation
query, and per-project journal storage. Node >= 18, CommonJS. See the
repository README for the full contract.

## Per-project journal routing

`projectRegistry` (`addProject` / `removeProject` / `listProjects`) persists
imported projects at `<home>/projects.json`: each entry pins a Git work tree
(`path`, resolved to the repo root) to a local storage root (`store`).
Capture-side `journalFor(home, repoIdentity)` then routes every conversation
event and commit boundary to `<store>/journal` for registered repos and to
the global `<home>/journal` for everything else — an unreadable or missing
registry never blocks capture. Registries only accept Git work trees because
event identity (workspaceId) is derived from the Git toplevel; importing a
subdirectory resolves to the repo root. Host boundaries appended through the
bridge facade follow the same routing; when a boundary lands in a project
journal, the returned `bridgeCursorAtCommit` stays at the global journal's
last sequence so consumer watermarks never skip unseen global content.

## Per-commit conversation sealing

`commitProjection` (`sealCommitConversations` / `rebuildSealedFiles` /
`sealDirFor`) turns a routed journal into a per-commit archive: when
`appendCommitBoundary` lands in a registered project's journal, the
conversations belonging to that commit are frozen into
`<store>/commits/<full-sha>.md` — Markdown with YAML frontmatter (commit
facts, boundary sequences, a provenance `contentHash`) followed by per-turn
用户/助手 bodies. Belongs-to rule: events between this boundary and the
repo's previous one, plus every turn still open at commit time
(`openTurnIdsAtCommit` — the ask is the requirement truth even before the
reply arrives). Window events that no turn consumed (a late reply) render
as an 未配对事件 appendix so every body lands in at least one file. Commits
without conversations seal nothing; the same sha never rewrites (amend gets
its own file, the old one stays as immutable evidence); `sealedAt` derives
from persisted boundary facts, so rebuilds are byte-stable. Projection
failures are reported in the facade result's `projection` field and never
fail the boundary append — the journal remains the only source of truth.

`src/bin/commit-boundary.js` (npm bin `bridge-commit-boundary`) is the
signal-injection entry: `--cwd <repo> [--home ...] [--sha] [--branch]`
resolves the repo identity from the working tree, reads HEAD facts from
git, appends the boundary and prints one JSON line — the shape a managed
git post-commit hook calls. `examples/seal-demo.js` runs the full flow
standalone in a temp directory.

### CLI

Since 0.5.0 the package also publishes a dispatcher named after itself
(npm's default bin rule: command name = package name, scope stripped):

```bash
ai-coding-event-bridge commit-boundary --cwd <repo> [--home DIR]   # same as above
ai-coding-event-bridge serve [--port 8790] [--host 127.0.0.1]      # delegates to
                                                                   # the console package
```

`serve` requires `@sanqianx/ai-coding-event-bridge-console` — installed in
the same node_modules tree it is used in-process, otherwise the global
`ai-coding-event-bridge-console` shim is spawned. `bridge-commit-boundary`
stays as a compatibility alias for hooks written before 0.5.0.

### Journal as a conveyor (trim after seal)

For registered projects the journal is a conveyor, not an archive: once a
boundary's seal verifiably exists on disk, `appendCommitBoundary` trims the
journal through that sequence (`journal.trimThrough` also retires open-turn
state whose events fell below the watermark). A reply that arrives after the
trim lands as an orphan assistant event and seals into the next commit's
未配对事件 appendix, so no conversation body is ever dropped. If sealing
fails, the prefix stays and the next boundary's seal window covers it
(self-healing). `sealUncommittedTail` is the age fuse: conversations still
uncommitted after `maxAgeDays` (default 14) are sealed into
`commits/<day>-uncommitted-<seq>.md` and trimmed. `reconcileTrim` is the
boot-time check that trims through the newest boundary whose sealed file
exists — run it (like the console does at startup) to adopt pre-upgrade
journals or heal a crash between sealing and trimming.

**Warning**: after a trim, `commits/*.md` is the only copy of that span.
`rebuildSealedFiles` covers the untrimmed remainder only; treat the sealed
files (and their backups) as the archive of record.
