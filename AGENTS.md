# Repository maintenance

- Develop on `main`; create another branch only when the user explicitly requests one.
- `packages/console` is the self-contained package. CI must test and pack the workspaces that actually exist.
- Keep reusable tests in Git and generated logs, archives, and client state ignored.
- Back up and verify unique history and uncommitted files outside the repository before removing obsolete branches or worktrees.
- Preserve event capture, project identity, and journal data during cleanup. Do not publish packages or push release tags as part of branch maintenance.
