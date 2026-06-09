import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  closeSync as fsCloseSync,
  openSync as fsOpenSync,
  renameSync as fsRenameSync,
  statSync as fsStatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveConfigDir, selfArgs } from "./paths.js";
import type { DeferResult } from "./schedule.js";
import { QUOTA_WINDOW_MS } from "./state.js";
import type { AccountConfig, DaemonState } from "./types.js";

// --- Constants ---

const GRACEFUL_POLL_MS = 500;
const GRACEFUL_POLL_ATTEMPTS = 120; // 120 × 500ms = 60s
const POST_KILL_DELAY_MS = 1000;

// --- File path helpers ---

export function daemonPidPath(): string {
  return join(resolveConfigDir(), "daemon.json");
}

export function daemonLogPath(): string {
  return join(resolveConfigDir(), "daemon.log");
}

export function daemonStopPath(): string {
  return join(resolveConfigDir(), "daemon.stop");
}

export function daemonHeartbeatPath(): string {
  return join(resolveConfigDir(), "daemon.heartbeat");
}

// --- Log rotation ---

const MAX_LOG_BYTES = 512 * 1024; // 512 KB

export function rotateLogFile(logPath: string, maxBytes = MAX_LOG_BYTES): void {
  try {
    const stat = fsStatSync(logPath);
    if (stat.size > maxBytes) {
      fsRenameSync(logPath, `${logPath}.old`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// --- Heartbeat ---
//
// A liveness signal the daemon refreshes on a fixed interval. When the event
// loop is healthy the file's mtime stays fresh regardless of how long the ping
// interval is; when the loop wedges (e.g. the macOS sleep/wake timer busy-loop,
// libuv#2891 / oven-sh/bun#27766) the interval stops firing and the file goes
// stale. An external watchdog reads that staleness to recover the daemon.

const HEARTBEAT_INTERVAL_MS = 30_000;

interface Heartbeat {
  stop(): void;
}

export function startHeartbeat(deps?: {
  write?: () => void;
  intervalMs?: number;
}): Heartbeat {
  const write =
    deps?.write ??
    (() =>
      writeFileSync(daemonHeartbeatPath(), `${new Date().toISOString()}\n`));
  const intervalMs = deps?.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  // Never let a transient fs failure escape: an uncaught throw here (or in the
  // interval callback) would exit the very daemon the heartbeat protects. A
  // single missed beat is harmless — the watchdog's staleness threshold is many
  // beats wide, and the next tick recovers.
  const beat = () => {
    try {
      write();
    } catch {
      // missed beat — fine
    }
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

// --- Sleep watchdog ---
//
// libuv timers pause during macOS sleep (nodejs/node#20661). This means a ping
// that's in-flight when the lid closes will appear to "run" for the entire
// sleep duration — its execFile timeout doesn't fire until wake. The watchdog
// polls Date.now() and, if an interval tick fires much later than scheduled,
// treats the gap as system sleep and aborts the in-flight batch.

const WATCHDOG_INTERVAL_MS = 1_000;
const WATCHDOG_OVERSHOOT_MS = 5_000;

// Settle delay after detected system wake. The first ping attempt immediately
// after wake tends to fail because network/DNS/TLS hasn't fully re-established.
// macOS post-wake tasks (Time Machine, network reattach) commonly run ~15-30s.
const WAKE_SETTLE_MS = 20_000;

// After exhausting retries with failures still pending, cap the next sleep so
// the daemon recovers within minutes instead of waiting a full quota window.
const POST_FAILURE_SLEEP_MS = 15 * 60 * 1000;

// When every pending failure is a rate limit with a known reset time, wake just
// after the soonest reset rather than hammering on the 15-min cap. The small
// buffer absorbs clock skew between us and the server so we don't wake a beat
// early and immediately re-trip the same limit.
const RATE_LIMIT_RESET_BUFFER_MS = 60 * 1000;

interface Watchdog {
  stop(): void;
}

export function createWatchdog(onOvershoot: () => void): Watchdog {
  let lastTick = Date.now();
  let fired = false;
  const timer = setInterval(() => {
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    if (!fired && gap > WATCHDOG_INTERVAL_MS + WATCHDOG_OVERSHOOT_MS) {
      fired = true;
      onOvershoot();
    }
  }, WATCHDOG_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

// --- PID file management ---

export function writeDaemonState(state: DaemonState): void {
  const configDir = resolveConfigDir();
  mkdirSync(configDir, { recursive: true });
  writeFileSync(daemonPidPath(), `${JSON.stringify(state, null, 2)}\n`);
}

export function readDaemonState(): DaemonState | null {
  const pidPath = daemonPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, "utf-8");
    return JSON.parse(raw) as DaemonState;
  } catch {
    return null;
  }
}

export function removeDaemonState(): boolean {
  const pidPath = daemonPidPath();
  if (!existsSync(pidPath)) return false;
  unlinkSync(pidPath);
  return true;
}

// --- Process checking ---

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    /* c8 ignore next -- EPERM requires foreign-owned process */
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

/* c8 ignore start -- subprocess call, tested via DI in getDaemonStatus */
function isDaemonProcess(pid: number): boolean {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output.includes("cc-ping");
  } catch {
    return false;
  }
}
/* c8 ignore stop */

interface DaemonProcessInfo {
  pid: number;
  args: string[];
}

/* c8 ignore start -- subprocess call, tested via DI in getDaemonStatus */
export function listDaemonProcesses(): DaemonProcessInfo[] {
  try {
    const output = execFileSync("ps", ["-ax", "-o", "pid=,command="], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const procs: DaemonProcessInfo[] = [];
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const tokens = trimmed.split(/\s+/);
      const pid = Number(tokens[0]);
      if (!Number.isInteger(pid)) continue;
      const command = tokens.slice(1);
      const isDaemon =
        command.includes("daemon") &&
        command.includes("_run") &&
        command.some((t) => t.includes("cc-ping") || t.includes("cli.js"));
      if (isDaemon) procs.push({ pid, args: command });
    }
    return procs;
  } catch {
    return [];
  }
}
/* c8 ignore stop */

// --- Parsing ---

export function parseInterval(value: string | undefined): number {
  if (!value) return QUOTA_WINDOW_MS;
  const minutes = Number(value);
  if (Number.isNaN(minutes)) {
    throw new Error(`Invalid interval value: ${value}`);
  }
  if (minutes <= 0) {
    throw new Error("Interval must be a positive number");
  }
  return minutes * 60 * 1000;
}

// --- Status ---

interface DaemonStatusResult {
  running: boolean;
  pid?: number;
  startedAt?: string;
  intervalMs?: number;
  uptime?: string;
  nextPingIn?: string;
  versionMismatch?: boolean;
  daemonVersion?: string;
  warnings?: string[];
}

export function getDaemonStatus(deps?: {
  isDaemonProcess?: (pid: number) => boolean;
  currentVersion?: string;
  listDaemonProcesses?: () => DaemonProcessInfo[];
  configDirExists?: (path: string) => boolean;
}): DaemonStatusResult {
  /* c8 ignore next -- real isDaemonProcess uses execFileSync, tested via DI */
  const _isDaemonProcess = deps?.isDaemonProcess ?? isDaemonProcess;
  const state = readDaemonState();
  if (!state) return { running: false };

  if (!isProcessRunning(state.pid) || !_isDaemonProcess(state.pid)) {
    removeDaemonState();
    return { running: false };
  }

  const startedAt = new Date(state.startedAt);
  const uptimeMs = Date.now() - startedAt.getTime();
  const uptime = formatUptime(uptimeMs);

  let nextPingIn: string | undefined;
  if (state.lastPingAt) {
    const nextPingMs =
      new Date(state.lastPingAt).getTime() + state.intervalMs - Date.now();
    nextPingIn = formatUptime(Math.max(0, nextPingMs));
  }

  const currentVersion = deps?.currentVersion;
  const versionMismatch =
    currentVersion != null && state.version != null
      ? state.version !== currentVersion
      : false;

  const warnings: string[] = [];
  const processes = deps?.listDaemonProcesses?.();
  if (processes) {
    const self = processes.find((p) => p.pid === state.pid);
    if (self && !self.args.includes("--notify")) {
      warnings.push(
        "running without --notify — desktop failure notifications are off",
      );
    }
    if (self && !self.args.includes("--auto-update")) {
      warnings.push(
        "running without --auto-update — won't self-restart after an upgrade",
      );
    }
    if (processes.length > 1) {
      const pids = processes.map((p) => p.pid).join(", ");
      warnings.push(
        `${processes.length} daemon processes are running (pids: ${pids}) — only one should be`,
      );
    }
  }
  if (deps?.configDirExists?.(state.configDir) === false) {
    warnings.push(`config dir is missing: ${state.configDir}`);
  }

  return {
    running: true,
    pid: state.pid,
    startedAt: state.startedAt,
    intervalMs: state.intervalMs,
    uptime,
    nextPingIn,
    versionMismatch,
    daemonVersion: state.version,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function msUntilUtcHour(targetHour: number, now: Date): number {
  const currentMs =
    now.getUTCHours() * 3600_000 +
    now.getUTCMinutes() * 60_000 +
    now.getUTCSeconds() * 1000 +
    now.getUTCMilliseconds();
  const targetMs = targetHour * 3600_000;
  const diff = targetMs - currentMs;
  return diff >= 0 ? diff : diff + 24 * 3600_000;
}

export function hasVersionChanged(
  runningVersion: string | undefined,
  getInstalledVersion: () => string,
): boolean {
  if (!runningVersion) return false;
  try {
    return getInstalledVersion() !== runningVersion;
  } catch {
    return false;
  }
}

export function formatDrift(
  actualHour: number,
  actualMinute: number,
  optimalHour: number,
): string | null {
  const driftMin = actualHour * 60 + actualMinute - optimalHour * 60;
  const wrapped =
    driftMin > 720
      ? driftMin - 1440
      : driftMin < -720
        ? driftMin + 1440
        : driftMin;
  if (Math.abs(wrapped) > 120) return null;
  const sign = wrapped > 0 ? "+" : wrapped < 0 ? "-" : "";
  const hh = String(actualHour).padStart(2, "0");
  const mm = String(actualMinute).padStart(2, "0");
  const oh = String(optimalHour).padStart(2, "0");
  return `${hh}:${mm} UTC (optimal: ${oh}:00, drift: ${sign}${Math.abs(wrapped)}m)`;
}

// --- Daemon loop ---

interface DaemonLoopDeps {
  runPing: (
    accounts: AccountConfig[],
    options: {
      parallel: boolean;
      quiet: boolean;
      bell?: boolean;
      notify?: boolean;
      quietFailure?: boolean;
      wakeDelayMs?: number;
      signal?: AbortSignal;
    },
  ) => Promise<{
    failedHandles: string[];
    failureReasons?: Record<string, string>;
    rateLimitResets?: Record<string, string>;
  }>;
  listAccounts: () => AccountConfig[];
  sleep: (ms: number) => Promise<void>;
  shouldStop: () => boolean;
  log: (msg: string) => void;
  updateState?: (patch: Partial<DaemonState>) => void;
  isWindowActive?: (handle: string, configDir: string) => boolean;
  shouldDeferPing?: (handle: string, configDir: string) => DeferResult;
  consumeWake?: () => boolean;
  getOptimalHour?: (handle: string, configDir: string) => number | undefined;
  hasUpgraded?: () => boolean;
  now?: () => Date;
  monotonicNow?: () => number;
  createWatchdog?: (onOvershoot: () => void) => Watchdog;
  configDirPresent?: () => boolean;
}

// How many consecutive iterations with a vanished config dir before the daemon
// gives up. A daemon whose config dir was deleted (e.g. a stray scoped to a temp
// dir) would otherwise spin forever with nothing to do.
const MAX_MISSING_CONFIG_ITERATIONS = 3;

export async function daemonLoop(
  intervalMs: number,
  options: { quiet?: boolean; bell?: boolean; notify?: boolean },
  deps: DaemonLoopDeps,
): Promise<"stop" | "upgrade"> {
  let wakeDelayMs: number | undefined;
  let postFailureSleepCap: number | undefined;
  let missingConfigStreak = 0;
  while (!deps.shouldStop()) {
    // Cap is single-use: clear at the top of every iteration so it only
    // applies to the sleep right after the failed iteration that set it.
    postFailureSleepCap = undefined;
    if (deps.hasUpgraded?.()) {
      deps.log("Binary upgraded, exiting for restart...");
      return "upgrade";
    }

    // A daemon whose config dir was deleted out from under it has nothing to
    // ping and would otherwise spin forever. Bail after a few consecutive
    // misses (consecutive, so a transient blip doesn't kill a healthy daemon).
    if (deps.configDirPresent && !deps.configDirPresent()) {
      missingConfigStreak++;
      if (missingConfigStreak >= MAX_MISSING_CONFIG_ITERATIONS) {
        deps.log(
          `Config dir has been missing for ${missingConfigStreak} iterations, exiting.`,
        );
        return "stop";
      }
    } else {
      missingConfigStreak = 0;
    }

    const wakeRequested = deps.consumeWake?.() === true;
    const allAccounts = deps.listAccounts();
    let accounts = deps.isWindowActive
      ? allAccounts.filter((a) => !deps.isWindowActive!(a.handle, a.configDir))
      : allAccounts;
    const activeHandles = new Set(accounts.map((a) => a.handle));
    const skippedHandles = allAccounts
      .filter((a) => !activeHandles.has(a.handle))
      .map((a) => a.handle);

    if (skippedHandles.length > 0) {
      deps.log(
        `Skipping ${skippedHandles.length} account(s) with active window: ${skippedHandles.join(", ")}`,
      );
    }

    let soonestDeferHour: number | undefined;
    if (deps.shouldDeferPing && !wakeRequested) {
      const deferResults = new Map<string, DeferResult>();
      for (const a of accounts) {
        deferResults.set(a.handle, deps.shouldDeferPing(a.handle, a.configDir));
      }
      const deferred = [...deferResults.entries()].filter(([, r]) => r.defer);
      if (deferred.length > 0) {
        accounts = accounts.filter((a) => !deferResults.get(a.handle)?.defer);
        const deferDetail = deferred
          .map(
            ([h, r]) =>
              `${h} → ${r.deferUntilUtcHour !== undefined ? `${String(r.deferUntilUtcHour).padStart(2, "0")}:00 UTC` : "later"}`,
          )
          .join(", ");
        deps.log(`Deferring ${deferred.length} account(s): ${deferDetail}`);
        // Track the soonest deferred hour for sleep calculation
        for (const [, r] of deferred) {
          if (
            r.deferUntilUtcHour !== undefined &&
            (soonestDeferHour === undefined ||
              /* c8 ignore next -- production default */
              msUntilUtcHour(r.deferUntilUtcHour, deps.now?.() ?? new Date()) <
                /* c8 ignore next -- production default */
                msUntilUtcHour(soonestDeferHour, deps.now?.() ?? new Date()))
          ) {
            soonestDeferHour = r.deferUntilUtcHour;
          }
        }
      }
    }

    if (accounts.length === 0) {
      deps.log(
        allAccounts.length === 0
          ? "No accounts configured, waiting..."
          : soonestDeferHour !== undefined
            ? "All accounts deferred (smart scheduling), waiting..."
            : "All accounts have active windows, waiting...",
      );
    } else {
      if (wakeDelayMs !== undefined) {
        await deps.sleep(WAKE_SETTLE_MS);
      }
      deps.log(`Pinging ${accounts.length} account(s)...`);
      const pingOpts = {
        parallel: false,
        quiet: options.quiet ?? true,
        bell: options.bell,
        notify: options.notify,
        wakeDelayMs,
      };
      /* c8 ignore next -- production default */
      const _createWatchdog = deps.createWatchdog ?? createWatchdog;
      const runGuarded = async (
        accts: AccountConfig[],
        quietFailure: boolean,
      ) => {
        const controller = new AbortController();
        let aborted = false;
        const wd = _createWatchdog(() => {
          deps.log("Detected system sleep, aborting in-flight ping(s)...");
          aborted = true;
          controller.abort();
        });
        try {
          const result = await deps.runPing(accts, {
            ...pingOpts,
            quietFailure,
            signal: controller.signal,
          });
          return { ...result, aborted };
        } finally {
          wd.stop();
        }
      };
      const {
        failedHandles,
        aborted: firstAborted,
        rateLimitResets: firstResets,
      } = await runGuarded(accounts, true);
      if (deps.getOptimalHour) {
        /* c8 ignore next -- production default */
        const now = deps.now?.() ?? new Date();
        for (const a of accounts) {
          const hour = deps.getOptimalHour(a.handle, a.configDir);
          if (hour !== undefined) {
            const drift = formatDrift(
              now.getUTCHours(),
              now.getUTCMinutes(),
              hour,
            );
            if (drift) deps.log(`${a.handle}: pinged at ${drift}`);
          }
        }
      }
      const MAX_RETRIES = 2;
      const RETRY_BACKOFF_BASE_MS = 5_000;
      const RETRY_BACKOFF_MULTIPLIER = 3;
      let pendingFailed = failedHandles;
      let prevAborted = firstAborted;
      // Reset times for the accounts still failing. Each attempt only re-pings
      // the pending set, so the latest attempt's map is authoritative for it.
      let pendingResets = firstResets ?? {};
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (pendingFailed.length === 0 || deps.shouldStop()) break;
        const retryAccounts = accounts.filter((a) =>
          pendingFailed.includes(a.handle),
        );
        const backoffMs =
          RETRY_BACKOFF_BASE_MS * RETRY_BACKOFF_MULTIPLIER ** attempt;
        const delayMs = prevAborted
          ? Math.max(WAKE_SETTLE_MS, backoffMs)
          : backoffMs;
        await deps.sleep(delayMs);
        deps.log(`Retrying ${retryAccounts.length} account(s)...`);
        const isLast = attempt === MAX_RETRIES - 1;
        const retry = await runGuarded(retryAccounts, !isLast);
        pendingFailed = retry.failedHandles;
        prevAborted = retry.aborted;
        pendingResets = retry.rateLimitResets ?? {};
        if (isLast && retry.failedHandles.length > 0) {
          const reasons = retry.failureReasons;
          const summary = retry.failedHandles
            .map((h) => {
              const r = reasons?.[h];
              return r ? `${h} (${r})` : h;
            })
            .join(", ");
          deps.log(`Retry failed for: ${summary}`);
        }
      }
      if (pendingFailed.length > 0) {
        // If every pending failure is a rate limit with a known reset, sleep
        // until the soonest reset (a 429 won't clear before then, so retrying
        // sooner just wastes pings and notifications). Otherwise fall back to
        // the short cap so transient outages recover within minutes.
        const allRateLimited = pendingFailed.every((h) => pendingResets[h]);
        if (allRateLimited) {
          /* c8 ignore next -- production default */
          const nowMs = (deps.now?.() ?? new Date()).getTime();
          const soonest = Math.min(
            ...pendingFailed.map((h) => new Date(pendingResets[h]).getTime()),
          );
          const untilReset = soonest - nowMs + RATE_LIMIT_RESET_BUFFER_MS;
          postFailureSleepCap =
            untilReset > 0 ? untilReset : POST_FAILURE_SLEEP_MS;
        } else {
          postFailureSleepCap = POST_FAILURE_SLEEP_MS;
        }
      }
      deps.updateState?.({ lastPingAt: new Date().toISOString() });
    }

    if (deps.shouldStop()) break;
    let sleepMs = intervalMs;
    if (postFailureSleepCap !== undefined && sleepMs > postFailureSleepCap) {
      sleepMs = postFailureSleepCap;
    }
    if (soonestDeferHour !== undefined) {
      const msUntilDefer = msUntilUtcHour(
        soonestDeferHour,
        /* c8 ignore next -- production default */
        deps.now?.() ?? new Date(),
      );
      if (msUntilDefer > 0 && msUntilDefer < intervalMs) {
        sleepMs = msUntilDefer;
      }
    }
    if (deps.getOptimalHour) {
      /* c8 ignore next -- production default */
      const now = deps.now?.() ?? new Date();
      for (const a of allAccounts) {
        const hour = deps.getOptimalHour(a.handle, a.configDir);
        if (hour !== undefined) {
          const msUntil = msUntilUtcHour(hour, now);
          if (msUntil > 0 && msUntil < sleepMs) {
            sleepMs = msUntil;
          }
        }
      }
    }
    deps.log(`Sleeping ${Math.round(sleepMs / 60_000)}m until next ping...`);
    /* c8 ignore next -- production default */
    const _monotonicNow = deps.monotonicNow ?? (() => performance.now());
    const sleepStart = _monotonicNow();
    await deps.sleep(sleepMs);
    const overshootMs = _monotonicNow() - sleepStart - sleepMs;
    if (overshootMs > 60_000) {
      wakeDelayMs = overshootMs;
      deps.log(`Woke ${formatUptime(overshootMs)} late (system sleep?)`);
    } else {
      wakeDelayMs = undefined;
    }
  }
  return "stop";
}

// --- Start ---

interface StartDaemonDeps {
  spawn: typeof spawn;
  getDaemonStatus: () => DaemonStatusResult;
  writeDaemonState: (state: DaemonState) => void;
  openSync: (path: string, flags: string) => number;
  closeSync: (fd: number) => void;
  rotateLog?: (logPath: string) => void;
  listDaemonProcesses?: () => DaemonProcessInfo[];
}

export function startDaemon(
  options: {
    interval?: string;
    quiet?: boolean;
    bell?: boolean;
    notify?: boolean;
    smartSchedule?: boolean;
    version?: string;
  },
  deps?: Partial<StartDaemonDeps>,
): { success: boolean; pid?: number; error?: string } {
  /* c8 ignore next 5 -- production defaults */
  const _getDaemonStatus = deps?.getDaemonStatus ?? getDaemonStatus;
  const _spawn = deps?.spawn ?? spawn;
  const _writeDaemonState = deps?.writeDaemonState ?? writeDaemonState;
  const _openSync = deps?.openSync ?? fsOpenSync;
  const _closeSync = deps?.closeSync ?? fsCloseSync;

  const status = _getDaemonStatus();
  if (status.running) {
    return {
      success: false,
      pid: status.pid,
      error: "Daemon is already running",
    };
  }

  // Single-instance enforcement is otherwise per-config-dir (the PID file lives
  // under resolveConfigDir()). Scan machine-wide so a daemon scoped to a
  // different — or deleted — config dir can't run alongside this one and
  // double-ping the same accounts.
  /* c8 ignore next -- production default, tested via DI */
  const _listDaemonProcesses = deps?.listDaemonProcesses ?? listDaemonProcesses;
  const others = _listDaemonProcesses();
  if (others.length > 0) {
    const pids = others.map((p) => p.pid).join(", ");
    return {
      success: false,
      pid: others[0].pid,
      error: `Another cc-ping daemon is already running (pid ${pids}), possibly under a different config dir. Stop it first: cc-ping daemon stop`,
    };
  }

  let intervalMs: number;
  try {
    intervalMs = parseInterval(options.interval);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }

  const configDir = resolveConfigDir();
  mkdirSync(configDir, { recursive: true });

  const _rotateLog = deps?.rotateLog ?? rotateLogFile;
  const logPath = daemonLogPath();
  _rotateLog(logPath);
  const logFd = _openSync(logPath, "a");

  const args = ["daemon", "_run", "--interval-ms", String(intervalMs)];
  if (options.quiet) args.push("--quiet");
  if (options.bell) args.push("--bell");
  if (options.notify) args.push("--notify");
  if (options.smartSchedule === false) args.push("--smart-schedule", "off");

  const [exe, ...prefix] = selfArgs();
  const child = _spawn(exe, [...prefix, ...args], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });

  if (!child.pid) {
    _closeSync(logFd);
    return { success: false, error: "Failed to spawn daemon process" };
  }

  child.unref();
  _closeSync(logFd);

  _writeDaemonState({
    pid: child.pid,
    startedAt: new Date().toISOString(),
    intervalMs,
    configDir,
    version: options.version,
  });

  return { success: true, pid: child.pid };
}

// --- Stop ---

interface StopDaemonDeps {
  getDaemonStatus: () => DaemonStatusResult;
  writeStopFile: () => void;
  isProcessRunning: (pid: number) => boolean;
  removeDaemonState: () => boolean;
  removeStopFile: () => void;
  sleep: (ms: number) => Promise<void>;
  kill: (pid: number) => void;
  forceKill: (pid: number) => void;
  log: (msg: string) => void;
}

export async function stopDaemon(
  deps?: Partial<StopDaemonDeps>,
): Promise<{ success: boolean; pid?: number; error?: string }> {
  /* c8 ignore next -- production default */
  const _getDaemonStatus = deps?.getDaemonStatus ?? getDaemonStatus;
  const _writeStopFile =
    deps?.writeStopFile ??
    /* c8 ignore next 5 -- production default */
    (() => {
      const configDir = resolveConfigDir();
      mkdirSync(configDir, { recursive: true });
      writeFileSync(daemonStopPath(), "");
    });
  /* c8 ignore next 2 -- production defaults */
  const _isProcessRunning = deps?.isProcessRunning ?? isProcessRunning;
  const _removeDaemonState = deps?.removeDaemonState ?? removeDaemonState;
  const _removeStopFile =
    deps?.removeStopFile ??
    /* c8 ignore next 4 -- production default */
    (() => {
      const stopPath = daemonStopPath();
      if (existsSync(stopPath)) unlinkSync(stopPath);
    });
  /* c8 ignore next 3 -- production default */
  const _sleep =
    deps?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /* c8 ignore next -- production default */
  const _kill =
    deps?.kill ??
    /* c8 ignore next 7 -- production default */
    ((pid: number) => {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(pid)]);
      } else {
        process.kill(pid, "SIGTERM");
      }
    });
  /* c8 ignore next -- production default */
  const _forceKill =
    deps?.forceKill ??
    /* c8 ignore next 7 -- production default */
    ((pid: number) => {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/F", "/PID", String(pid)]);
      } else {
        process.kill(pid, "SIGKILL");
      }
    });
  /* c8 ignore next -- production default */
  const _log = deps?.log ?? ((msg: string) => console.log(msg));

  const status = _getDaemonStatus();
  if (!status.running || !status.pid) {
    return { success: false, error: "Daemon is not running" };
  }

  const pid = status.pid;
  _writeStopFile();
  _log(`Waiting for daemon to stop (PID: ${pid})...`);

  // Poll for graceful exit
  for (let i = 0; i < GRACEFUL_POLL_ATTEMPTS; i++) {
    await _sleep(GRACEFUL_POLL_MS);
    if (!_isProcessRunning(pid)) {
      _removeDaemonState();
      _removeStopFile();
      return { success: true, pid };
    }
  }

  // Graceful exit timed out — send SIGTERM
  _log("Force-killing daemon...");
  try {
    _kill(pid);
  } catch {
    // Process may have already exited
  }

  await _sleep(POST_KILL_DELAY_MS);

  // Escalate to SIGKILL if still alive
  if (_isProcessRunning(pid)) {
    try {
      _forceKill(pid);
    } catch {
      // Process may have already exited
    }
    await _sleep(POST_KILL_DELAY_MS);
  }

  _removeDaemonState();
  _removeStopFile();

  if (_isProcessRunning(pid)) {
    return {
      success: false,
      pid,
      error: `Failed to stop daemon (PID: ${pid})`,
    };
  }
  return { success: true, pid };
}

// --- Polling sleep ---
//
// A sleep that periodically checks whether it should bail out early. Used to
// let stop/wake sentinels interrupt the daemon's main idle period without
// waiting for the full timeout to elapse.

export async function pollingSleep(
  ms: number,
  opts: { isInterrupted: () => boolean; pollMs: number },
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (opts.isInterrupted()) return;
    const wait = Math.min(opts.pollMs, deadline - Date.now());
    await new Promise<void>((resolve) => setTimeout(resolve, wait));
  }
}

// --- Wake ---

interface WakeDaemonDeps {
  getDaemonStatus: () => DaemonStatusResult;
  writeWakeFile: () => void;
}

export async function wakeDaemon(
  deps?: Partial<WakeDaemonDeps>,
): Promise<{ success: boolean; pid?: number; error?: string }> {
  /* c8 ignore next -- production default */
  const _getDaemonStatus = deps?.getDaemonStatus ?? getDaemonStatus;
  const _writeWakeFile =
    deps?.writeWakeFile ??
    /* c8 ignore next 5 -- production default */
    (() => {
      const dir = resolveConfigDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "daemon.wake"), "");
    });
  const status = _getDaemonStatus();
  if (!status.running || !status.pid) {
    return { success: false, error: "Daemon is not running" };
  }
  // If the daemon stops between the status check and the write, the sentinel
  // sits until the next start consumes it — which triggers an immediate ping
  // anyway. So the race is benign and intentionally not guarded.
  _writeWakeFile();
  return { success: true, pid: status.pid };
}

// --- Run (called by _run subcommand) ---

interface RunDaemonDeps extends DaemonLoopDeps {
  onSignal: (signal: string, handler: () => void) => void;
  removeSignal: (signal: string, handler: () => void) => void;
  exit: (code: number) => void;
}

export async function runDaemon(
  intervalMs: number,
  options: { quiet?: boolean; bell?: boolean; notify?: boolean },
  deps: RunDaemonDeps,
): Promise<void> {
  const stopPath = daemonStopPath();

  // Clear stale stop file from a previous crash — without this,
  // a service-manager restart would immediately exit.
  if (existsSync(stopPath)) unlinkSync(stopPath);

  const cleanup = () => {
    if (existsSync(stopPath)) unlinkSync(stopPath);
    removeDaemonState();
  };

  const onSigterm = () => {
    deps.log("Received SIGTERM, shutting down...");
    cleanup();
    deps.exit(0);
  };

  const onSigint = () => {
    deps.log("Received SIGINT, shutting down...");
    cleanup();
    deps.exit(0);
  };

  deps.onSignal("SIGTERM", onSigterm);
  deps.onSignal("SIGINT", onSigint);

  deps.log(`Daemon started. Interval: ${Math.round(intervalMs / 60_000)}m`);

  let exitReason: "stop" | "upgrade" = "stop";
  try {
    exitReason = await daemonLoop(intervalMs, options, deps);
  } finally {
    deps.removeSignal("SIGTERM", onSigterm);
    deps.removeSignal("SIGINT", onSigint);

    deps.log("Daemon stopping...");
    cleanup();
  }

  if (exitReason === "upgrade") {
    deps.exit(75); // EX_TEMPFAIL — triggers service manager restart
  }
}

/* c8 ignore start -- production wiring only */
export async function runDaemonWithDefaults(
  intervalMs: number,
  options: {
    quiet?: boolean;
    bell?: boolean;
    notify?: boolean;
    smartSchedule?: boolean;
    autoUpdate?: boolean;
  },
): Promise<void> {
  const stopPath = daemonStopPath();
  const wakePath = join(resolveConfigDir(), "daemon.wake");
  const { runPing } = await import("./run-ping.js");
  const { listAccounts } = await import("./config.js");
  const { getWindowReset, pruneOrphanState } = await import("./state.js");
  const { checkRecentActivity, readAccountSchedule, shouldDefer } =
    await import("./schedule.js");

  const tsLog = (msg: string) =>
    console.log(`[${new Date().toISOString()}] ${msg}`);

  const prunedOrphans = pruneOrphanState(listAccounts().map((a) => a.handle));
  if (prunedOrphans.length > 0) {
    tsLog(`Pruned orphan state for: ${prunedOrphans.join(", ")}`);
  }

  const smartScheduleEnabled = options.smartSchedule !== false;
  let shouldDeferPing:
    | ((handle: string, configDir: string) => DeferResult)
    | undefined;

  if (smartScheduleEnabled) {
    // Log computed schedules at startup for debuggability
    for (const account of listAccounts()) {
      const resetAt = account.scheduleResetAt
        ? new Date(account.scheduleResetAt)
        : undefined;
      const schedule = readAccountSchedule(
        account.configDir,
        new Date(),
        resetAt,
      );
      if (schedule) {
        tsLog(
          `Smart schedule: ${account.handle} → optimal ping at ${schedule.optimalPingHour}:00 UTC`,
        );
      } else {
        tsLog(
          `Smart schedule: ${account.handle} → insufficient history, using fixed interval`,
        );
      }
    }

    shouldDeferPing = (handle: string, configDir: string) => {
      const accounts = listAccounts();
      const account = accounts.find((a) => a.handle === handle);
      const resetAt = account?.scheduleResetAt
        ? new Date(account.scheduleResetAt)
        : undefined;
      const schedule = readAccountSchedule(configDir, new Date(), resetAt);
      if (!schedule) return { defer: false };
      return shouldDefer(new Date(), schedule.optimalPingHour);
    };
  }

  let hasUpgraded: (() => boolean) | undefined;
  if (options.autoUpdate) {
    // Use CC_PING_BIN (set by service template) or fall back to PATH lookup.
    // The shim path is stable across upgrades — its contents change to
    // point at the new version, so running it returns the new version.
    let ccPingBin = process.env.CC_PING_BIN;
    if (!ccPingBin) {
      try {
        ccPingBin = execFileSync("which", ["cc-ping"], {
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
      } catch {
        tsLog(
          "Auto-update: cc-ping not found in PATH, version checks disabled",
        );
      }
    }
    if (ccPingBin) {
      hasUpgraded = () =>
        hasVersionChanged(readDaemonState()?.version, () =>
          execFileSync(ccPingBin, ["--version"], { timeout: 5000 })
            .toString()
            .trim(),
        );
    }
  }

  const SLEEP_POLL_MS = 1_000;
  // Liveness signal for the external watchdog. Refreshed on its own interval so
  // it stays fresh through a 5h idle but goes stale the moment the event loop
  // wedges — which is what the watchdog keys off to force a recovery. unref'd,
  // so it never keeps the process alive on its own.
  const heartbeat = startHeartbeat();
  await runDaemon(intervalMs, options, {
    runPing,
    listAccounts,
    sleep: (ms) =>
      pollingSleep(ms, {
        isInterrupted: () => existsSync(stopPath) || existsSync(wakePath),
        pollMs: SLEEP_POLL_MS,
      }),
    shouldStop: () => existsSync(stopPath),
    configDirPresent: () => existsSync(resolveConfigDir()),
    consumeWake: () => {
      if (!existsSync(wakePath)) return false;
      try {
        unlinkSync(wakePath);
      } catch {
        // already removed by another caller — fine
      }
      return true;
    },
    log: tsLog,
    isWindowActive: (handle, configDir) => {
      if (getWindowReset(handle) !== null) return true;
      return checkRecentActivity(configDir);
    },
    shouldDeferPing,
    getOptimalHour: smartScheduleEnabled
      ? (handle, configDir) => {
          const account = listAccounts().find((a) => a.handle === handle);
          const resetAt = account?.scheduleResetAt
            ? new Date(account.scheduleResetAt)
            : undefined;
          const schedule = readAccountSchedule(configDir, new Date(), resetAt);
          return schedule?.optimalPingHour;
        }
      : undefined,
    hasUpgraded,
    updateState: (patch) => {
      const current = readDaemonState();
      if (current) writeDaemonState({ ...current, ...patch });
    },
    onSignal: (signal, handler) => process.on(signal, handler),
    removeSignal: (signal, handler) => process.removeListener(signal, handler),
    exit: (code) => process.exit(code),
  });
  heartbeat.stop();
}
/* c8 ignore stop */
