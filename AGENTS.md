# PiClaw

Self-hosted AI workspace wrapping the Pi Coding Agent. Single-process Bun application with embedded SQLite; no external services required.

## Cursor Cloud specific instructions

### Runtime

- **Bun v1.3.11** is the sole runtime. Node/npm/yarn are not used. The required version is in `BUN_VERSION`.
- Bun must be on `$PATH` before any command. If installed via `bun.sh`, source `~/.bashrc` or export `BUN_INSTALL="$HOME/.bun"` and add `$BUN_INSTALL/bin` to `PATH`.

### Key commands

All build/lint/test targets are in the root `Makefile` and `package.json` scripts. Refer to `docs/development.md` for details.

| Task | Command |
|---|---|
| Install deps | `bun install` |
| Build web assets | `bun run build:web` (runs vendor + bundle pipeline) |
| Lint | `make lint` |
| Test | `make test` (sets `PICLAW_DB_IN_MEMORY=1` automatically) |
| Type-check | `bun run typecheck` |
| Dev server | `bun run dev` (watch mode on port 8080) |
| Full build | `make build-piclaw` |

### Gotchas

- The test suite hardcodes `/workspace/piclaw` as the expected repo root in a few path-resolution tests (`vendor-workflow.test.ts`, `repo-dev-command.test.ts`). When the repo is checked out at `/workspace` directly (as in Cloud Agent VMs), ~23 tests fail with path mismatches. These are pre-existing and unrelated to code changes. **Workaround:** Create a symlink to satisfy the hardcoded paths: `ln -s /workspace /workspace/piclaw`.
- Web assets must be built (`bun run build:web`) before the dev server can serve the UI. The build is idempotent and safe to re-run.
- Tests must run sequentially (`--max-concurrency=1`) for SQLite safety. The `make test` / `bun run test` scripts enforce this.
- The dev server creates state in `/workspace/.piclaw/` (SQLite DB, IPC files). Do not delete `messages.db`.
- No LLM provider API keys are needed in environment variables; PiClaw uses provider credentials configured in the Pi Agent settings (via the `/login` command in the web UI).
