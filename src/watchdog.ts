import { statSync, unlinkSync } from "node:fs";
import {
  daemonHeartbeatPath,
  isProcessRunning,
  readDaemonState,
  removeDaemonState,
} from "./daemon.js";
import type { DaemonState } from "./types.js";

export function readHeartbeatAge(deps: {
  path: () => string;
  mtimeMs: (path: string) => number;
  now: () => number;
}): number | null {
  try {
    return deps.now() - deps.mtimeMs(deps.path());
  } catch {
    return null;
  }
}

type HealthcheckResult = "no-daemon" | "no-heartbeat" | "healthy" | "restarted";

interface HealthcheckDeps {
  readState: () => DaemonState | null;
  isRunning: (pid: number) => boolean;
  heartbeatAgeMs: () => number | null;
  kill: (pid: number) => void;
  clearState: () => void;
  log: (msg: string) => void;
  staleMs?: number;
}

export const DEFAULT_HEARTBEAT_STALE_MS = 3 * 60 * 1000;

export function runHealthcheck(deps: HealthcheckDeps): HealthcheckResult {
  const state = deps.readState();
  if (!state || !deps.isRunning(state.pid)) return "no-daemon";
  const age = deps.heartbeatAgeMs();
  if (age === null) return "no-heartbeat";
  const staleMs = deps.staleMs ?? DEFAULT_HEARTBEAT_STALE_MS;
  if (age <= staleMs) return "healthy";
  deps.log(
    `Daemon (pid ${state.pid}) heartbeat is ${Math.round(age / 1000)}s stale — force-restarting`,
  );
  deps.kill(state.pid);
  deps.clearState();
  return "restarted";
}

// Force-restarting means SIGKILL: a wedged event loop ignores SIGTERM (its
// handler is event-loop-driven too). The service manager then relaunches it —
// launchd KeepAlive(SuccessfulExit=false) and systemd Restart=on-failure both
// treat a signal death as a failure. We clear the stale pid/heartbeat files so
// the relaunched process writes fresh state instead of inheriting the old pid.
/* c8 ignore start -- production wiring only */
export function runHealthcheckWithDefaults(): HealthcheckResult {
  const tsLog = (msg: string) =>
    console.log(`[${new Date().toISOString()}] ${msg}`);
  return runHealthcheck({
    readState: readDaemonState,
    isRunning: isProcessRunning,
    heartbeatAgeMs: () =>
      readHeartbeatAge({
        path: daemonHeartbeatPath,
        mtimeMs: (p) => statSync(p).mtimeMs,
        now: () => Date.now(),
      }),
    kill: (pid) => process.kill(pid, "SIGKILL"),
    clearState: () => {
      removeDaemonState();
      try {
        unlinkSync(daemonHeartbeatPath());
      } catch {
        // already gone — fine
      }
    },
    log: tsLog,
  });
}
/* c8 ignore stop */
