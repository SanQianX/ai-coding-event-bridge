# @sanqianx/ai-coding-event-bridge-console

Local console for the AI coding event bridge: a vector-hub-style dark UI for
browsing captured conversations, a JSON query API shared with AI agents, and
project import that pins each project's records to a local storage address.

## Usage

```bash
# from the repository root
npm install
npm run serve                      # http://127.0.0.1:8790

# or as a CLI once published
npx ai-coding-event-bridge-console serve [--port 8790] [--host 127.0.0.1] [--home DIR]
```

The server binds to `127.0.0.1` by default — journals contain full
conversation bodies, so they stay on this machine unless `--host` says
otherwise.

## Projects

- **导入项目** (sidebar): pick a local Git work tree (subdirectories resolve to
  the repo root) and optionally a **记录保存地址**. From then on, conversations
  and commit boundaries captured inside that project are appended to
  `<store>/journal` instead of the global journal. Legacy events already in the
  global journal are still shown for the project.
- **自动发现** (`auto` tag): repos that were captured but never imported read
  from the global journal only.
- **注销** (hover a registered project): removes the registration only; data on
  disk is never deleted, and new capture falls back to the global journal.
- The folder picker uses a native dialog on Windows; elsewhere (or with
  `BRIDGE_CONSOLE_PICK_FOLDER=0`) type the path manually.

## API

| Route | Description |
| --- | --- |
| `GET /api/health` | `{ ok, home, registeredProjects, first/lastSequence }` |
| `GET /api/system/agents` | Detect installed agent tools (Claude Code / Codex / OpenCode: CLI, config, hook wiring) + bridge runtime info + consumers |

Agent detection distinguishes a found command/config from installed capture.
Consumer registration never installs an Agent hook. In a host-embedded console,
“管理 Agent 采集” opens the host's connector installer. ZCode status requires both
managed events and `hooks.enabled`; hooks installed under an explicit Bridge
home read that home's runtime even when the external Agent inherits no home
environment variable. ZCode's Claude-compatible payloads retain source `zcode`.
| `POST /api/system/upgrade-runtime` | Materialize/activate the runtime at the core package version (designed same-major upgrade path) |
| `GET /api/system/pick-folder` | Native folder dialog (win32; 501 elsewhere) |
| `GET /api/projects` | Registered + auto-discovered projects with turn counts |
| `POST /api/projects` | `{ path, store? }` — import (Git work trees only) |
| `DELETE /api/projects?id=` | Unregister (data stays on disk) |
| `GET /api/dates?project=` | Days with turns + counts (for the date chips) |
| `GET /api/turns?project&date&cursor&limit` | Merged turns + `annotations` (commit shas per turn) |
| `GET /api/sessions?project=` | Session index |
| `GET /api/search?q&project&limit` | Substring search over conversation bodies |
| `GET /api/journals` | Global and registered project journal identities |
| `POST /api/internal/workbench-event` | Private native Workbench capture; runtime token, loopback, no browser Origin |

The private capture route uses `KB_EVENT_BRIDGE_RUNTIME_TOKEN`. It resolves the
Git identity and requires an already registered code directory. Stable event
keys deduplicate retries; only original prompts, successful final answers and
turn endings enter the same bridge journal used by hooks. Credentials and
injected knowledge are not accepted as event metadata. Shell proxies must not
expose this route to browser callers.

Turn merging: for a registered project, the project journal and the global
journal (legacy pre-import events) are both read, filtered by repo identity,
ordered by capture time. Sequence-span commit annotations only compare within
one journal's sequence space; `openTurnIdsAtCommit` binding works across both.

## Notes

- Node >= 18, CommonJS, zero runtime dependencies beyond the core package.
- Public query APIs read journals; project import/unregister changes registration.
  The authenticated Workbench endpoint delegates capture to the core bridge,
  not a second conversation database.
- Consumer cursors and ACKs are journal-specific. Compaction may retire sealed
  evidence only after every applicable consumer has acknowledged that journal;
  creating a commit archive is not proof that the engine consumed it.
