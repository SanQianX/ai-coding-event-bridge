# ai-coding-event-bridge

Durable AI coding event capture bridge for Claude Code, Codex and OpenCode,
with atomic Git commit boundaries, multi-consumer cursors and a shared
conversation explorer UI.

## Packages

- `@sanqianx/ai-coding-event-bridge` — core engine (Node >= 18, CommonJS):
  durable journal, atomic `appendEvent()` / `appendCommitBoundary()` under one
  cross-process lock, repo/session/turn identity normalization with no fake
  evidence, per-client connectors and installers, compaction bounded by
  consumer acks, and a headless conversation query.
- `@sanqianx/ai-coding-event-bridge-ui` — framework-neutral mature
  Conversation Explorer (project + date only) with host adapters for data and
  commit annotations.

## Installers

Installers materialize one per-user runtime (`~/.ai-coding-event-bridge`) and
point Claude/Codex/OpenCode managed entries at a stable shim — never into a
host `node_modules`. Multiple consumers (for example project-knowledge and
DevTask-Radar) register themselves; managed hooks are removed only when the
last consumer unregisters. Third-party hooks and configs are always preserved.

## Development

```bash
npm ci
npm test
npm pack --workspace packages/core --dry-run
npm pack --workspace packages/ui --dry-run
```

Releases are published from a protected `workflow_dispatch` bound to an exact
verified commit SHA with npm provenance; this repository creates no Git tags
for package releases.

## License

MIT
