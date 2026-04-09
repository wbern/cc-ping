# cc-ping

## Development

- **Package manager**: `pnpm` — use `pnpm test`, `pnpm build`, not `npx`
- **Test runner**: vitest — `pnpm test` for quick runs, `pnpm test:coverage` for full coverage
- **Coverage threshold**: 100% lines, branches, functions, statements — use `/* c8 ignore */` only for genuinely unreachable branches (race guards, catch blocks on already-exited processes)
- **Linter**: biome (not eslint)
- **Dead code**: knip — exported types/functions must be used or knip will block commit

## Pre-commit hooks

The pre-commit hook runs all of these (takes ~6s):

1. biome check
2. secretlint
3. tsc --noEmit
4. knip
5. build (tsup)
6. test:coverage

If knip or coverage fails, the commit is rejected. Fix the issue and create a new commit (don't amend).

## Architecture

- **Dependency injection**: All side effects are injected via `deps` params. Production defaults are in the function body; tests pass mocks. This pattern is used in `daemon.ts`, `service.ts`, `ping.ts`, `run-ping.ts`, and others.
- **Single file per concern**: `ping.ts` (spawn claude), `run-ping.ts` (orchestrate + output), `daemon.ts` (loop + lifecycle), `service.ts` (launchd/systemd), `state.ts` (ping timestamps), `config.ts` (account CRUD).
- **No classes**: Everything is plain functions + interfaces.

## Timeout model

`execFile` timeout sends SIGTERM, but if the child ignores it the callback never fires. The `pingOne` function has a hard-kill timer (SIGKILL after 35s) that force-resolves the promise as a backstop. Both the callback and the timer use a `resolved` flag to prevent double-resolution.

## Daemon behavior

- Single instance enforced via PID file + process name check
- Retries only failed accounts once before sleeping
- Detects system sleep via timer overshoot (>60s late)
- Graceful stop: sentinel file polled every 500ms for up to 60s, then SIGTERM

## Smart scheduling

The daemon analyzes usage patterns from `~/.claude-accounts/<handle>/history.jsonl` (prompt timestamps) and times pings so the 5-hour quota window covers peak activity. Algorithm: bin by hour-of-day (last 14 days), slide a 5h window to find the densest period, ping at `midpoint - 5h`. A defer zone (5h before optimal ping) delays fixed-interval pings that would waste the window. Falls back to fixed interval with <7 days of data or flat histogram.
