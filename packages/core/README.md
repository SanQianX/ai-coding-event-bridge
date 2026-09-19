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
