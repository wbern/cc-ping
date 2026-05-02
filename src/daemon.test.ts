import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => join(tmpdir(), `cc-ping-daemon-${process.pid}`),
  };
});

const {
  parseInterval,
  writeDaemonState,
  readDaemonState,
  removeDaemonState,
  isProcessRunning,
  getDaemonStatus,
  daemonLoop,
  startDaemon,
  stopDaemon,
  wakeDaemon,
  pollingSleep,
  runDaemon,
  daemonPidPath,
  daemonLogPath,
  daemonStopPath,
  msUntilUtcHour,
  hasVersionChanged,
  rotateLogFile,
  formatDrift,
  createWatchdog,
} = await import("./daemon.js");
const { QUOTA_WINDOW_MS } = await import("./state.js");

const configDir = join(
  tmpdir(),
  `cc-ping-daemon-${process.pid}`,
  ".config",
  "cc-ping",
);

// PID guaranteed to not exist — Linux max is ~4M, macOS ~100K
const NONEXISTENT_PID = 2147483647;

describe("daemon", () => {
  beforeEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  describe("file path helpers", () => {
    it("returns daemon.json path", () => {
      expect(daemonPidPath()).toBe(join(configDir, "daemon.json"));
    });

    it("returns daemon.log path", () => {
      expect(daemonLogPath()).toBe(join(configDir, "daemon.log"));
    });

    it("returns daemon.stop path", () => {
      expect(daemonStopPath()).toBe(join(configDir, "daemon.stop"));
    });
  });

  describe("parseInterval", () => {
    it("returns QUOTA_WINDOW_MS when value is undefined", () => {
      expect(parseInterval(undefined)).toBe(QUOTA_WINDOW_MS);
    });

    it("parses minutes to milliseconds", () => {
      expect(parseInterval("60")).toBe(60 * 60 * 1000);
    });

    it("parses fractional minutes", () => {
      expect(parseInterval("0.5")).toBe(0.5 * 60 * 1000);
    });

    it("throws for non-numeric value", () => {
      expect(() => parseInterval("abc")).toThrow("Invalid interval value: abc");
    });

    it("throws for zero", () => {
      expect(() => parseInterval("0")).toThrow(
        "Interval must be a positive number",
      );
    });

    it("throws for negative value", () => {
      expect(() => parseInterval("-5")).toThrow(
        "Interval must be a positive number",
      );
    });
  });

  describe("msUntilUtcHour", () => {
    it("returns ms until a future hour today", () => {
      const now = new Date("2026-04-09T06:00:00Z");
      // 8 UTC is 2h away
      expect(msUntilUtcHour(8, now)).toBe(2 * 3600_000);
    });

    it("wraps to next day when target hour has passed", () => {
      const now = new Date("2026-04-09T10:00:00Z");
      // 8 UTC already passed, should be ~22h until tomorrow 8 UTC
      expect(msUntilUtcHour(8, now)).toBe(22 * 3600_000);
    });

    it("returns 0 when now is exactly at the target hour", () => {
      const now = new Date("2026-04-09T08:00:00.000Z");
      // At exactly 08:00:00.000 UTC, the 08:00 ping slot is NOW — the caller
      // should not sleep 24h before taking it.
      expect(msUntilUtcHour(8, now)).toBe(0);
    });
  });

  describe("rotateLogFile", () => {
    it("rotates log file when it exceeds max size", () => {
      const logPath = join(configDir, "test.log");
      writeFileSync(logPath, "x".repeat(1024));
      rotateLogFile(logPath, 512);
      expect(existsSync(logPath)).toBe(false);
      expect(existsSync(`${logPath}.old`)).toBe(true);
      expect(readFileSync(`${logPath}.old`, "utf-8")).toBe("x".repeat(1024));
    });

    it("does not rotate when file is under max size", () => {
      const logPath = join(configDir, "test.log");
      writeFileSync(logPath, "x".repeat(100));
      rotateLogFile(logPath, 512);
      expect(existsSync(logPath)).toBe(true);
      expect(existsSync(`${logPath}.old`)).toBe(false);
    });

    it("does nothing when log file does not exist", () => {
      const logPath = join(configDir, "nonexistent.log");
      rotateLogFile(logPath);
      expect(existsSync(logPath)).toBe(false);
    });

    it("rethrows non-ENOENT errors", () => {
      // Stat on a path through a file (not a dir) triggers ENOTDIR
      const filePath = join(configDir, "afile");
      writeFileSync(filePath, "x");
      const badPath = join(filePath, "nested.log");
      expect(() => rotateLogFile(badPath)).toThrow();
    });
  });

  describe("createWatchdog", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not call onOvershoot on normal ticks", () => {
      vi.useFakeTimers();
      const onOvershoot = vi.fn();
      const wd = createWatchdog(onOvershoot);
      vi.advanceTimersByTime(5_000);
      wd.stop();
      expect(onOvershoot).not.toHaveBeenCalled();
    });

    it("calls onOvershoot when tick gap exceeds threshold", () => {
      const start = new Date("2026-04-18T00:00:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(start);
      const onOvershoot = vi.fn();
      const wd = createWatchdog(onOvershoot);
      vi.setSystemTime(new Date(start.getTime() + 60_000));
      vi.advanceTimersToNextTimer();
      wd.stop();
      expect(onOvershoot).toHaveBeenCalledTimes(1);
    });

    it("calls onOvershoot at most once even across multiple overshoot ticks", () => {
      const start = new Date("2026-04-18T00:00:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(start);
      const onOvershoot = vi.fn();
      const wd = createWatchdog(onOvershoot);
      vi.setSystemTime(new Date(start.getTime() + 60_000));
      vi.advanceTimersToNextTimer();
      vi.setSystemTime(new Date(start.getTime() + 120_000));
      vi.advanceTimersToNextTimer();
      wd.stop();
      expect(onOvershoot).toHaveBeenCalledTimes(1);
    });

    it("stop clears the interval", () => {
      vi.useFakeTimers();
      const onOvershoot = vi.fn();
      const wd = createWatchdog(onOvershoot);
      wd.stop();
      const start = Date.now();
      vi.setSystemTime(start + 60_000);
      vi.advanceTimersByTime(10_000);
      expect(onOvershoot).not.toHaveBeenCalled();
    });
  });

  describe("formatDrift", () => {
    it("returns positive drift when actual is after optimal", () => {
      expect(formatDrift(8, 15, 8)).toBe(
        "08:15 UTC (optimal: 08:00, drift: +15m)",
      );
    });

    it("returns negative drift when actual is before optimal", () => {
      expect(formatDrift(7, 45, 8)).toBe(
        "07:45 UTC (optimal: 08:00, drift: -15m)",
      );
    });

    it("returns zero drift with no sign", () => {
      expect(formatDrift(8, 0, 8)).toBe(
        "08:00 UTC (optimal: 08:00, drift: 0m)",
      );
    });

    it("wraps midnight positive: actual 01:00 optimal 23:00 → +120m", () => {
      expect(formatDrift(1, 0, 23)).toBe(
        "01:00 UTC (optimal: 23:00, drift: +120m)",
      );
    });

    it("wraps midnight negative: actual 23:00 optimal 01:00 → -120m", () => {
      expect(formatDrift(23, 0, 1)).toBe(
        "23:00 UTC (optimal: 01:00, drift: -120m)",
      );
    });

    it("returns null when drift exceeds 120 minutes", () => {
      expect(formatDrift(12, 0, 8)).toBeNull();
    });

    it("returns null for large midnight-wrapped drift", () => {
      expect(formatDrift(5, 0, 23)).toBeNull();
    });
  });

  describe("PID file CRUD", () => {
    const state = {
      pid: 12345,
      startedAt: "2025-01-01T00:00:00.000Z",
      intervalMs: 300000,
      configDir: "/tmp/test",
    };

    it("writes and reads daemon state", () => {
      writeDaemonState(state);
      const read = readDaemonState();
      expect(read).toEqual(state);
    });

    it("returns null when no PID file exists", () => {
      expect(readDaemonState()).toBeNull();
    });

    it("returns null for corrupt PID file", () => {
      writeFileSync(daemonPidPath(), "not json");
      expect(readDaemonState()).toBeNull();
    });

    it("removes daemon state and returns true", () => {
      writeDaemonState(state);
      expect(removeDaemonState()).toBe(true);
      expect(readDaemonState()).toBeNull();
    });

    it("returns false when removing non-existent state", () => {
      expect(removeDaemonState()).toBe(false);
    });
  });

  describe("isProcessRunning", () => {
    it("returns true for current process", () => {
      expect(isProcessRunning(process.pid)).toBe(true);
    });

    it("returns false for non-existent PID", () => {
      expect(isProcessRunning(NONEXISTENT_PID)).toBe(false);
    });
  });

  // isDaemonProcess uses execSync which blocks in vitest thread workers.
  // Tested indirectly via getDaemonStatus DI and production use.

  describe("getDaemonStatus", () => {
    it("returns not running when no PID file exists", () => {
      const status = getDaemonStatus({ isDaemonProcess: () => true });
      expect(status.running).toBe(false);
      expect(status.pid).toBeUndefined();
    });

    it("returns running when PID file points to live process", () => {
      writeDaemonState({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        intervalMs: 300000,
        configDir,
      });

      const status = getDaemonStatus({ isDaemonProcess: () => true });
      expect(status.running).toBe(true);
      expect(status.pid).toBe(process.pid);
      expect(status.intervalMs).toBe(300000);
      expect(status.uptime).toBeDefined();
    });

    it("includes nextPingIn when lastPingAt is present", () => {
      const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString();
      writeDaemonState({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        intervalMs: 60000,
        configDir,
        lastPingAt: thirtySecondsAgo,
      });

      const status = getDaemonStatus({ isDaemonProcess: () => true });
      expect(status.running).toBe(true);
      expect(status.nextPingIn).toBeDefined();
      expect(status.nextPingIn).toMatch(/\d+s/);
    });

    it("cleans stale PID file and returns not running", () => {
      writeDaemonState({
        pid: NONEXISTENT_PID,
        startedAt: new Date().toISOString(),
        intervalMs: 300000,
        configDir,
      });

      const status = getDaemonStatus({ isDaemonProcess: () => true });
      expect(status.running).toBe(false);
      expect(readDaemonState()).toBeNull();
    });

    it("includes uptime string with minutes", () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      writeDaemonState({
        pid: process.pid,
        startedAt: fiveMinutesAgo.toISOString(),
        intervalMs: 300000,
        configDir,
      });

      const status = getDaemonStatus({ isDaemonProcess: () => true });
      expect(status.uptime).toMatch(/\d+m \d+s/);
    });

    it("shows seconds-only uptime for very recent start", () => {
      writeDaemonState({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        intervalMs: 300000,
        configDir,
      });

      const status = getDaemonStatus({ isDaemonProcess: () => true });
      expect(status.uptime).toMatch(/^\d+s$/);
    });

    it("shows hours in uptime for long-running daemon", () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      writeDaemonState({
        pid: process.pid,
        startedAt: twoHoursAgo.toISOString(),
        intervalMs: 300000,
        configDir,
      });

      const status = getDaemonStatus({ isDaemonProcess: () => true });
      expect(status.uptime).toMatch(/\d+h \d+m \d+s/);
    });

    it("reports version mismatch when daemon version differs from current", () => {
      writeDaemonState({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        intervalMs: 300000,
        configDir,
        version: "0.0.1",
      });

      const status = getDaemonStatus({
        isDaemonProcess: () => true,
        currentVersion: "1.0.0",
      });
      expect(status.running).toBe(true);
      expect(status.versionMismatch).toBe(true);
      expect(status.daemonVersion).toBe("0.0.1");
    });

    it("reports no version mismatch when daemon has no version (pre-upgrade)", () => {
      writeDaemonState({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        intervalMs: 300000,
        configDir,
      });

      const status = getDaemonStatus({
        isDaemonProcess: () => true,
        currentVersion: "1.0.0",
      });
      expect(status.running).toBe(true);
      expect(status.versionMismatch).toBe(false);
      expect(status.daemonVersion).toBeUndefined();
    });

    it("does not report version mismatch when versions match", () => {
      writeDaemonState({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        intervalMs: 300000,
        configDir,
        version: "1.0.0",
      });

      const status = getDaemonStatus({
        isDaemonProcess: () => true,
        currentVersion: "1.0.0",
      });
      expect(status.running).toBe(true);
      expect(status.versionMismatch).toBe(false);
    });

    it("cleans stale PID when process is alive but not cc-ping", () => {
      writeDaemonState({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        intervalMs: 300000,
        configDir,
      });

      const status = getDaemonStatus({ isDaemonProcess: () => false });
      expect(status.running).toBe(false);
      expect(readDaemonState()).toBeNull();
    });
  });

  describe("hasVersionChanged", () => {
    it("returns true when installed version differs from running version", () => {
      const result = hasVersionChanged("1.0.0", () => "2.0.0");
      expect(result).toBe(true);
    });

    it("returns false when versions match", () => {
      const result = hasVersionChanged("1.0.0", () => "1.0.0");
      expect(result).toBe(false);
    });

    it("returns false when running version is undefined", () => {
      const result = hasVersionChanged(undefined, () => "2.0.0");
      expect(result).toBe(false);
    });

    it("returns false when version check throws", () => {
      const result = hasVersionChanged("1.0.0", () => {
        throw new Error("not found");
      });
      expect(result).toBe(false);
    });
  });

  describe("daemonLoop", () => {
    it("pings accounts and stops when shouldStop returns true", async () => {
      let calls = 0;
      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          calls++;
          return calls > 1;
        }),
        log: vi.fn(),
      };

      await daemonLoop(60000, {}, deps);

      expect(deps.runPing).toHaveBeenCalledTimes(1);
      expect(deps.listAccounts).toHaveBeenCalledTimes(1);
    });

    it("passes options to runPing", async () => {
      let calls = 0;
      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          calls++;
          return calls > 1;
        }),
        log: vi.fn(),
      };

      await daemonLoop(60000, { bell: true, notify: true }, deps);

      expect(deps.runPing).toHaveBeenCalledWith(
        [{ handle: "alice", configDir: "/tmp/alice" }],
        expect.objectContaining({
          parallel: false,
          quiet: true,
          bell: true,
          notify: true,
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("aborts the in-flight batch when watchdog detects sleep", async () => {
      let calls = 0;
      let overshootFn: (() => void) | undefined;
      const stop = vi.fn();
      const capturedSignals: AbortSignal[] = [];
      const deps = {
        runPing: vi.fn().mockImplementation(async (_, opts) => {
          capturedSignals.push(opts.signal);
          overshootFn?.();
          return { failedHandles: [] };
        }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          calls++;
          return calls > 1;
        }),
        log: vi.fn(),
        createWatchdog: (cb: () => void) => {
          overshootFn = cb;
          return { stop };
        },
      };

      await daemonLoop(60000, {}, deps);

      expect(capturedSignals[0].aborted).toBe(true);
      expect(deps.log).toHaveBeenCalledWith(
        "Detected system sleep, aborting in-flight ping(s)...",
      );
      expect(stop).toHaveBeenCalled();
    });

    it("bypasses defer logic when consumeWake returns true", async () => {
      let calls = 0;
      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          calls++;
          return calls > 1;
        }),
        log: vi.fn(),
        shouldDeferPing: () => ({ defer: true, deferUntilUtcHour: 14 }),
        consumeWake: vi.fn(() => true),
      };

      await daemonLoop(60000, {}, deps);

      expect(deps.consumeWake).toHaveBeenCalled();
      expect(deps.runPing).toHaveBeenCalledTimes(1);
    });

    it("waits with exponential backoff between retries (5s, then 15s)", async () => {
      let calls = 0;
      let runPingCallCount = 0;
      const sleepCalls: number[] = [];
      const deps = {
        runPing: vi.fn().mockImplementation(async () => {
          runPingCallCount++;
          return runPingCallCount < 3
            ? { failedHandles: ["alice"] }
            : { failedHandles: [] };
        }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockImplementation(async (ms: number) => {
          sleepCalls.push(ms);
        }),
        shouldStop: vi.fn(() => {
          calls++;
          return calls > 3;
        }),
        log: vi.fn(),
        createWatchdog: () => ({ stop: vi.fn() }),
      };

      await daemonLoop(60000, {}, deps);

      expect(sleepCalls).toContain(5000);
      expect(sleepCalls).toContain(15000);
    });

    it("retries up to 2 additional times when previous attempts keep failing", async () => {
      let calls = 0;
      let runPingCallCount = 0;
      const deps = {
        runPing: vi.fn().mockImplementation(async () => {
          runPingCallCount++;
          return runPingCallCount < 3
            ? { failedHandles: ["alice"] }
            : { failedHandles: [] };
        }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          calls++;
          return calls > 3;
        }),
        log: vi.fn(),
        createWatchdog: () => ({ stop: vi.fn() }),
      };

      await daemonLoop(60000, {}, deps);

      expect(runPingCallCount).toBe(3);
    });

    it("passes quietFailure on all attempts except the final one", async () => {
      let calls = 0;
      const capturedQuietFailure: (boolean | undefined)[] = [];
      const deps = {
        runPing: vi.fn().mockImplementation(async (_, opts) => {
          capturedQuietFailure.push(opts.quietFailure);
          return { failedHandles: ["alice"] };
        }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          calls++;
          return calls > 3;
        }),
        log: vi.fn(),
        createWatchdog: () => ({ stop: vi.fn() }),
      };

      await daemonLoop(60000, {}, deps);

      expect(capturedQuietFailure).toEqual([true, true, false]);
    });

    it("uses a fresh controller for retry after watchdog abort", async () => {
      let calls = 0;
      let runPingCallCount = 0;
      const capturedSignals: AbortSignal[] = [];
      const deps = {
        runPing: vi.fn().mockImplementation(async (_, opts) => {
          runPingCallCount++;
          capturedSignals.push(opts.signal);
          return runPingCallCount === 1
            ? { failedHandles: ["alice"] }
            : { failedHandles: [] };
        }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          calls++;
          return calls > 2;
        }),
        log: vi.fn(),
        createWatchdog: () => ({ stop: vi.fn() }),
      };

      await daemonLoop(60000, {}, deps);

      expect(runPingCallCount).toBe(2);
      expect(capturedSignals[0]).not.toBe(capturedSignals[1]);
    });

    it("settles before retry when watchdog aborted the first attempt", async () => {
      let stopCalls = 0;
      let runPingCallCount = 0;
      let overshootFn: (() => void) | undefined;
      const deps = {
        runPing: vi.fn().mockImplementation(async () => {
          runPingCallCount++;
          if (runPingCallCount === 1) {
            overshootFn?.();
            return { failedHandles: ["alice"] };
          }
          return { failedHandles: [] };
        }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          stopCalls++;
          return stopCalls > 2;
        }),
        log: vi.fn(),
        createWatchdog: (cb: () => void) => {
          overshootFn = cb;
          return { stop: vi.fn() };
        },
      };

      await daemonLoop(60_000, {}, deps);

      expect(deps.runPing).toHaveBeenCalledTimes(2);
      // First sleep call is the settle before retry (< interval),
      // not the between-iteration interval sleep.
      const firstSleep = deps.sleep.mock.calls[0]?.[0];
      expect(firstSleep).toBeGreaterThan(0);
      expect(firstSleep).toBeLessThan(60_000);
      const settleOrder = deps.sleep.mock.invocationCallOrder[0];
      const retryPingOrder = deps.runPing.mock.invocationCallOrder[1];
      expect(settleOrder).toBeLessThan(retryPingOrder);
    });

    it("shortens sleep after retry exhaustion so failures recover sooner", async () => {
      let calls = 0;
      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: ["alice"] }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          calls++;
          return calls > 4;
        }),
        log: vi.fn(),
        createWatchdog: () => ({ stop: vi.fn() }),
      };

      const FIVE_HOURS = 5 * 60 * 60 * 1000;
      await daemonLoop(FIVE_HOURS, {}, deps);

      // Per iteration the loop sleeps: backoff(5s), backoff(15s), then the
      // post-iteration sleep. The cap should clamp that last one to 15min.
      const FIFTEEN_MIN = 15 * 60 * 1000;
      const sleepArgs = deps.sleep.mock.calls.map((c) => c[0] as number);
      const postIterationSleeps = sleepArgs.filter(
        (ms) => ms !== 5_000 && ms !== 15_000,
      );
      expect(postIterationSleeps.length).toBeGreaterThan(0);
      for (const ms of postIterationSleeps) {
        expect(ms).toBe(FIFTEEN_MIN);
      }
    });

    it("clears the post-failure cap after a no-op iteration", async () => {
      let calls = 0;
      let iteration = 0;
      const FIVE_HOURS = 5 * 60 * 60 * 1000;
      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: ["alice"] }),
        listAccounts: vi.fn().mockImplementation(() => {
          iteration++;
          // Iteration 1: alice present and fails, sets the cap.
          // Iteration 2+: no accounts at all, so the if/else doesn't run.
          return iteration === 1
            ? [{ handle: "alice", configDir: "/tmp/alice" }]
            : [];
        }),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          calls++;
          return calls > 6;
        }),
        log: vi.fn(),
        createWatchdog: () => ({ stop: vi.fn() }),
      };

      await daemonLoop(FIVE_HOURS, {}, deps);

      const sleepArgs = deps.sleep.mock.calls.map((c) => c[0] as number);
      // Filter out the retry backoffs (5s, 15s) from iteration 1.
      const longSleeps = sleepArgs.filter(
        (ms) => ms !== 5_000 && ms !== 15_000,
      );
      // The first long sleep is iteration 1's capped sleep (15min).
      // The next one must be the full interval — proving the cap cleared.
      expect(longSleeps[1]).toBe(FIVE_HOURS);
    });

    it("sleeps for interval between pings", async () => {
      let calls = 0;
      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          calls++;
          return calls > 2;
        }),
        log: vi.fn(),
      };

      await daemonLoop(120000, {}, deps);

      expect(deps.sleep).toHaveBeenCalledWith(120000);
    });

    it("logs message when no accounts configured", async () => {
      let calls = 0;
      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi.fn().mockReturnValue([]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          calls++;
          return calls > 1;
        }),
        log: vi.fn(),
      };

      await daemonLoop(60000, {}, deps);

      expect(deps.runPing).not.toHaveBeenCalled();
      expect(deps.log).toHaveBeenCalledWith(
        "No accounts configured, waiting...",
      );
    });

    it("stops before sleep if shouldStop becomes true", async () => {
      let calls = 0;
      const deps = {
        runPing: vi.fn().mockImplementation(async () => {
          calls++;
          return { failedHandles: [] };
        }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => calls >= 1),
        log: vi.fn(),
      };

      await daemonLoop(60000, {}, deps);

      expect(deps.sleep).not.toHaveBeenCalled();
    });

    it("writes lastPingAt to state after pinging accounts", async () => {
      let calls = 0;
      const updateState = vi.fn();
      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          calls++;
          return calls > 1;
        }),
        log: vi.fn(),
        updateState,
      };

      await daemonLoop(60000, {}, deps);

      expect(updateState).toHaveBeenCalledTimes(1);
      expect(updateState).toHaveBeenCalledWith({
        lastPingAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
    });

    it("skips accounts whose quota window is still active", async () => {
      let calls = 0;
      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi.fn().mockReturnValue([
          { handle: "alice", configDir: "/tmp/alice" },
          { handle: "bob", configDir: "/tmp/bob" },
        ]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          calls++;
          return calls > 1;
        }),
        log: vi.fn(),
        isWindowActive: vi.fn((handle: string) => handle === "alice"),
      };

      await daemonLoop(60000, {}, deps);

      expect(deps.runPing).toHaveBeenCalledWith(
        [{ handle: "bob", configDir: "/tmp/bob" }],
        expect.any(Object),
      );
      expect(deps.log).toHaveBeenCalledWith(
        expect.stringContaining("Skipping 1 account(s) with active window"),
      );
    });

    it("retries only failed accounts before sleeping", async () => {
      let loopCalls = 0;
      const deps = {
        runPing: vi
          .fn()
          .mockResolvedValueOnce({ failedHandles: ["alice"] })
          .mockResolvedValueOnce({ failedHandles: [] }),
        listAccounts: vi.fn().mockReturnValue([
          { handle: "alice", configDir: "/tmp/alice" },
          { handle: "bob", configDir: "/tmp/bob" },
        ]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          loopCalls++;
          return loopCalls > 2;
        }),
        log: vi.fn(),
      };

      await daemonLoop(60000, {}, deps);

      expect(deps.runPing).toHaveBeenCalledTimes(2);
      // First call: all accounts
      expect(deps.runPing.mock.calls[0][0]).toEqual([
        { handle: "alice", configDir: "/tmp/alice" },
        { handle: "bob", configDir: "/tmp/bob" },
      ]);
      // Retry: only the failed account
      expect(deps.runPing.mock.calls[1][0]).toEqual([
        { handle: "alice", configDir: "/tmp/alice" },
      ]);
    });

    it("logs failed handles when all retry attempts also fail", async () => {
      let loopCalls = 0;
      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: ["alice"] }),
        listAccounts: vi.fn().mockReturnValue([
          { handle: "alice", configDir: "/tmp/alice" },
          { handle: "bob", configDir: "/tmp/bob" },
        ]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          loopCalls++;
          return loopCalls > 3;
        }),
        log: vi.fn(),
      };

      await daemonLoop(60000, {}, deps);

      expect(deps.log).toHaveBeenCalledWith("Retry failed for: alice");
    });

    it("skips retry when shouldStop becomes true after failed ping", async () => {
      let pingCalls = 0;
      const deps = {
        runPing: vi.fn().mockImplementation(async () => {
          pingCalls++;
          return { failedHandles: ["alice"] };
        }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => pingCalls >= 1),
        log: vi.fn(),
      };

      await daemonLoop(60000, {}, deps);

      expect(deps.runPing).toHaveBeenCalledTimes(1);
      expect(deps.sleep).not.toHaveBeenCalled();
    });

    it("passes wakeDelayMs to runPing when sleep overshoots by more than 60s", async () => {
      let stopCalls = 0;
      const now = vi.spyOn(Date, "now");
      let clock = 1000000;
      now.mockImplementation(() => clock);

      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockImplementation(async () => {
          // Simulate 60s interval + 120s overshoot from system sleep
          clock += 60_000 + 120_000;
        }),
        shouldStop: vi.fn(() => {
          stopCalls++;
          // Flow: top(1) → ping → mid(2) → sleep → top(3) → ping → mid(4)
          return stopCalls > 3;
        }),
        log: vi.fn(),
        monotonicNow: () => clock,
      };

      await daemonLoop(60000, { notify: true }, deps);
      now.mockRestore();

      expect(deps.runPing).toHaveBeenCalledTimes(2);
      const firstCallOpts = deps.runPing.mock.calls[0][1];
      expect(firstCallOpts.wakeDelayMs).toBeUndefined();
      const secondCallOpts = deps.runPing.mock.calls[1][1];
      expect(secondCallOpts.wakeDelayMs).toBeGreaterThan(60_000);
      expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("late"));
    });

    it("settles before the first ping after a detected late wake", async () => {
      let stopCalls = 0;
      let sleepCount = 0;
      const now = vi.spyOn(Date, "now");
      let clock = 1000000;
      now.mockImplementation(() => clock);

      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockImplementation(async (ms: number) => {
          sleepCount++;
          clock += ms;
          // Only the first iteration's interval sleep triggers overshoot
          if (sleepCount === 1) clock += 120_000;
        }),
        shouldStop: vi.fn(() => {
          stopCalls++;
          return stopCalls > 3;
        }),
        log: vi.fn(),
        monotonicNow: () => clock,
      };

      await daemonLoop(60_000, {}, deps);
      now.mockRestore();

      expect(deps.runPing).toHaveBeenCalledTimes(2);
      // Sleep order expected: interval(60s), settle(<60s), then loop exits
      expect(deps.sleep.mock.calls[0][0]).toBe(60_000);
      const settleCall = deps.sleep.mock.calls[1]?.[0];
      expect(settleCall).toBeGreaterThan(0);
      expect(settleCall).toBeLessThan(60_000);
      // The settle must occur before the second runPing invocation
      const settleOrder = deps.sleep.mock.invocationCallOrder[1];
      const secondPingOrder = deps.runPing.mock.invocationCallOrder[1];
      expect(settleOrder).toBeLessThan(secondPingOrder);
    });

    it("detects wake via monotonic clock even when Date.now stays stable", async () => {
      let stopCalls = 0;
      let sleepCount = 0;
      let monoT = 1_000_000;
      // Wall clock is frozen — no backward jump needed to prove the point,
      // the absence of any wall-clock advance is already enough to break a
      // Date.now-based overshoot calculation.
      const now = vi.spyOn(Date, "now").mockReturnValue(5_000_000);

      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockImplementation(async (ms: number) => {
          sleepCount++;
          monoT += ms;
          // Monotonic clock reflects a real 120s overshoot on the first sleep
          if (sleepCount === 1) monoT += 120_000;
        }),
        shouldStop: vi.fn(() => {
          stopCalls++;
          return stopCalls > 3;
        }),
        log: vi.fn(),
        monotonicNow: () => monoT,
      };

      await daemonLoop(60_000, {}, deps);
      now.mockRestore();

      // Wake was real (monotonic clock advanced 180s across a 60s sleep),
      // so the second ping should be preceded by a settle (< 60s) sleep.
      expect(deps.runPing).toHaveBeenCalledTimes(2);
      const settleCall = deps.sleep.mock.calls[1]?.[0];
      expect(settleCall).toBeGreaterThan(0);
      expect(settleCall).toBeLessThan(60_000);
    });

    it("does not settle when sleep overshoot is under 60s", async () => {
      let stopCalls = 0;
      let sleepCount = 0;
      const now = vi.spyOn(Date, "now");
      let clock = 1000000;
      now.mockImplementation(() => clock);

      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockImplementation(async (ms: number) => {
          sleepCount++;
          clock += ms;
          if (sleepCount === 1) clock += 30_000;
        }),
        shouldStop: vi.fn(() => {
          stopCalls++;
          return stopCalls > 3;
        }),
        log: vi.fn(),
      };

      await daemonLoop(60_000, {}, deps);
      now.mockRestore();

      expect(deps.runPing).toHaveBeenCalledTimes(2);
      for (const call of deps.sleep.mock.calls) {
        expect(call[0]).toBeGreaterThanOrEqual(60_000);
      }
    });

    it("does not pass wakeDelayMs when sleep overshoot is under 60s", async () => {
      let stopCalls = 0;
      const now = vi.spyOn(Date, "now");
      let clock = 1000000;
      now.mockImplementation(() => clock);

      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockImplementation(async () => {
          // Simulate 60s interval + 30s overshoot (under threshold)
          clock += 60_000 + 30_000;
        }),
        shouldStop: vi.fn(() => {
          stopCalls++;
          return stopCalls > 3;
        }),
        log: vi.fn(),
      };

      await daemonLoop(60000, {}, deps);
      now.mockRestore();

      expect(deps.runPing).toHaveBeenCalledTimes(2);
      const secondCallOpts = deps.runPing.mock.calls[1][1];
      expect(secondCallOpts.wakeDelayMs).toBeUndefined();
    });

    it("logs waiting message when all accounts have active windows", async () => {
      let calls = 0;
      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          calls++;
          return calls > 1;
        }),
        log: vi.fn(),
        isWindowActive: vi.fn().mockReturnValue(true),
      };

      await daemonLoop(60000, {}, deps);

      expect(deps.runPing).not.toHaveBeenCalled();
      expect(deps.log).toHaveBeenCalledWith(
        "All accounts have active windows, waiting...",
      );
    });

    it("exits loop when binary upgrade is detected", async () => {
      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => false),
        log: vi.fn(),
        hasUpgraded: vi.fn().mockReturnValue(true),
      };

      const result = await daemonLoop(60000, {}, deps);

      expect(result).toBe("upgrade");
      expect(deps.log).toHaveBeenCalledWith(
        expect.stringContaining("upgraded"),
      );
      expect(deps.runPing).not.toHaveBeenCalled();
    });

    it("defers accounts when smart scheduling says to", async () => {
      let calls = 0;
      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi.fn().mockReturnValue([
          { handle: "alice", configDir: "/tmp/alice" },
          { handle: "bob", configDir: "/tmp/bob" },
        ]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          calls++;
          return calls > 1;
        }),
        log: vi.fn(),
        shouldDeferPing: vi.fn((handle: string, _configDir: string) =>
          handle === "alice"
            ? { defer: true, deferUntilUtcHour: 8 }
            : { defer: false },
        ),
      };

      await daemonLoop(60000, {}, deps);

      // Only bob should be pinged since alice is deferred
      expect(deps.runPing).toHaveBeenCalledWith(
        [{ handle: "bob", configDir: "/tmp/bob" }],
        expect.any(Object),
      );
      expect(deps.log).toHaveBeenCalledWith(
        expect.stringContaining("Deferring 1 account(s)"),
      );
    });

    it("shows 'later' in defer message when deferUntilUtcHour is undefined", async () => {
      let calls = 0;
      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          calls++;
          return calls > 1;
        }),
        log: vi.fn(),
        shouldDeferPing: vi.fn(() => ({ defer: true })),
      };

      await daemonLoop(60000, {}, deps);

      expect(deps.log).toHaveBeenCalledWith(
        "Deferring 1 account(s): alice → later",
      );
    });

    it("sleeps until soonest deferred account instead of full interval when all accounts deferred", async () => {
      let stopCalls = 0;
      const sleepFn = vi.fn().mockResolvedValue(undefined);

      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi.fn().mockReturnValue([
          { handle: "alice", configDir: "/tmp/alice" },
          { handle: "bob", configDir: "/tmp/bob" },
        ]),
        sleep: sleepFn,
        shouldStop: vi.fn(() => {
          stopCalls++;
          // First iteration: false at while-check (1), false at mid-check (2)
          // After sleep: true at while-check (3)
          return stopCalls > 2;
        }),
        log: vi.fn(),
        shouldDeferPing: vi.fn((handle: string, _configDir: string) =>
          handle === "alice"
            ? { defer: true, deferUntilUtcHour: 10 }
            : { defer: true, deferUntilUtcHour: 8 },
        ),
        now: () => new Date("2026-04-09T06:00:00Z"), // 6 UTC, soonest defer is 8 UTC = 2h away
      };

      await daemonLoop(300 * 60_000, {}, deps); // 5h interval

      // Should NOT have pinged anything
      expect(deps.runPing).not.toHaveBeenCalled();

      // Should sleep ~2h (until 8 UTC), not the full 5h
      const sleepMs = sleepFn.mock.calls[0][0];
      expect(sleepMs).toBeLessThan(300 * 60_000); // less than 5h
      expect(sleepMs).toBeGreaterThanOrEqual(2 * 60 * 60_000 - 1000); // ~2h (with small tolerance)
      expect(sleepMs).toBeLessThanOrEqual(2 * 60 * 60_000 + 1000);

      // Should log the correct message (not "active windows")
      expect(deps.log).toHaveBeenCalledWith(
        "All accounts deferred (smart scheduling), waiting...",
      );
    });
    it("shortens sleep to next optimal hour when it falls within the interval", async () => {
      let stopCalls = 0;
      const sleepFn = vi.fn().mockResolvedValue(undefined);

      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: sleepFn,
        shouldStop: vi.fn(() => {
          stopCalls++;
          return stopCalls > 2;
        }),
        log: vi.fn(),
        getOptimalHour: vi.fn().mockReturnValue(10), // 10 UTC
        now: () => new Date("2026-04-09T08:00:00Z"), // 8 UTC → 2h to optimal
      };

      await daemonLoop(300 * 60_000, {}, deps); // 5h interval

      const sleepMs = sleepFn.mock.calls[0][0];
      // Should sleep ~2h (until 10 UTC), not full 5h
      expect(sleepMs).toBeGreaterThanOrEqual(2 * 60 * 60_000 - 1000);
      expect(sleepMs).toBeLessThanOrEqual(2 * 60 * 60_000 + 1000);
    });

    it("does not shorten sleep when optimal hour is beyond the interval", async () => {
      let stopCalls = 0;
      const sleepFn = vi.fn().mockResolvedValue(undefined);

      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: sleepFn,
        shouldStop: vi.fn(() => {
          stopCalls++;
          return stopCalls > 2;
        }),
        log: vi.fn(),
        getOptimalHour: vi.fn().mockReturnValue(20), // 20 UTC
        now: () => new Date("2026-04-09T08:00:00Z"), // 8 UTC → 12h to optimal > 5h interval
      };

      await daemonLoop(300 * 60_000, {}, deps); // 5h interval

      const sleepMs = sleepFn.mock.calls[0][0];
      expect(sleepMs).toBe(300 * 60_000); // full 5h
    });

    it("uses shorter of deferred hour and optimal hour for sleep", async () => {
      let stopCalls = 0;
      const sleepFn = vi.fn().mockResolvedValue(undefined);

      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi.fn().mockReturnValue([
          { handle: "alice", configDir: "/tmp/alice" },
          { handle: "bob", configDir: "/tmp/bob" },
        ]),
        sleep: sleepFn,
        shouldStop: vi.fn(() => {
          stopCalls++;
          return stopCalls > 2;
        }),
        log: vi.fn(),
        shouldDeferPing: vi.fn((handle: string) =>
          handle === "alice"
            ? { defer: true, deferUntilUtcHour: 11 } // 3h away
            : { defer: false },
        ),
        getOptimalHour: vi.fn(
          (handle: string) => (handle === "bob" ? 9 : undefined), // bob at 9 UTC = 1h away (shorter)
        ),
        now: () => new Date("2026-04-09T08:00:00Z"),
      };

      await daemonLoop(300 * 60_000, {}, deps);

      const sleepMs = sleepFn.mock.calls[0][0];
      // Should sleep ~1h (bob's optimal at 9), not ~3h (alice's deferred at 11)
      expect(sleepMs).toBeGreaterThanOrEqual(1 * 60 * 60_000 - 1000);
      expect(sleepMs).toBeLessThanOrEqual(1 * 60 * 60_000 + 1000);
    });

    it("logs drift from optimal hour after pinging", async () => {
      let stopCalls = 0;
      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          stopCalls++;
          return stopCalls > 1;
        }),
        log: vi.fn(),
        getOptimalHour: vi.fn().mockReturnValue(8),
        now: () => new Date("2026-04-09T08:03:00Z"),
      };

      await daemonLoop(60000, {}, deps);

      expect(deps.log).toHaveBeenCalledWith(
        "alice: pinged at 08:03 UTC (optimal: 08:00, drift: +3m)",
      );
    });

    it("does not log drift when account has no optimal hour", async () => {
      let stopCalls = 0;
      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi
          .fn()
          .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
        sleep: vi.fn().mockResolvedValue(undefined),
        shouldStop: vi.fn(() => {
          stopCalls++;
          return stopCalls > 1;
        }),
        log: vi.fn(),
        getOptimalHour: vi.fn().mockReturnValue(undefined),
        now: () => new Date("2026-04-09T08:03:00Z"),
      };

      await daemonLoop(60000, {}, deps);

      const driftLogs = deps.log.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "string" && call[0].includes("drift"),
      );
      expect(driftLogs).toHaveLength(0);
    });

    it("picks the soonest optimal hour across multiple accounts", async () => {
      let stopCalls = 0;
      const sleepFn = vi.fn().mockResolvedValue(undefined);

      const deps = {
        runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
        listAccounts: vi.fn().mockReturnValue([
          { handle: "alice", configDir: "/tmp/alice" },
          { handle: "bob", configDir: "/tmp/bob" },
        ]),
        sleep: sleepFn,
        shouldStop: vi.fn(() => {
          stopCalls++;
          return stopCalls > 2;
        }),
        log: vi.fn(),
        getOptimalHour: vi.fn((handle: string) =>
          handle === "alice" ? 12 : 10,
        ), // bob at 10 UTC is soonest
        now: () => new Date("2026-04-09T08:00:00Z"), // 8 UTC
      };

      await daemonLoop(300 * 60_000, {}, deps);

      const sleepMs = sleepFn.mock.calls[0][0];
      // Should sleep ~2h (until bob's 10 UTC), not 4h (alice's 12 UTC)
      expect(sleepMs).toBeGreaterThanOrEqual(2 * 60 * 60_000 - 1000);
      expect(sleepMs).toBeLessThanOrEqual(2 * 60 * 60_000 + 1000);
    });
  });

  describe("startDaemon", () => {
    it("returns error when daemon is already running", () => {
      const result = startDaemon(
        {},
        {
          getDaemonStatus: () => ({ running: true, pid: 123 }),
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Daemon is already running");
      expect(result.pid).toBe(123);
    });

    it("returns error for invalid interval", () => {
      const result = startDaemon(
        { interval: "abc" },
        {
          getDaemonStatus: () => ({ running: false }),
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid interval value: abc");
    });

    it("spawns child and writes PID state", () => {
      const mockChild = { pid: 9876, unref: vi.fn() };
      const mockSpawn = vi.fn().mockReturnValue(mockChild);
      const mockWriteState = vi.fn();
      const mockCloseSync = vi.fn();

      const result = startDaemon(
        { interval: "60" },
        {
          getDaemonStatus: () => ({ running: false }),
          spawn: mockSpawn as never,
          writeDaemonState: mockWriteState,
          openSync: vi.fn().mockReturnValue(3),
          closeSync: mockCloseSync,
        },
      );

      expect(result.success).toBe(true);
      expect(result.pid).toBe(9876);
      expect(mockChild.unref).toHaveBeenCalled();
      expect(mockCloseSync).toHaveBeenCalledWith(3);
      expect(mockWriteState).toHaveBeenCalledWith(
        expect.objectContaining({
          pid: 9876,
          intervalMs: 3600000,
        }),
      );
    });

    it("passes flags to spawn args", () => {
      const mockChild = { pid: 9876, unref: vi.fn() };
      const mockSpawn = vi.fn().mockReturnValue(mockChild);

      startDaemon(
        { interval: "5", quiet: true, bell: true, notify: true },
        {
          getDaemonStatus: () => ({ running: false }),
          spawn: mockSpawn as never,
          writeDaemonState: vi.fn(),
          openSync: vi.fn().mockReturnValue(3),
          closeSync: vi.fn(),
        },
      );

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain("--quiet");
      expect(spawnArgs).toContain("--bell");
      expect(spawnArgs).toContain("--notify");
      expect(spawnArgs).toContain("--interval-ms");
      expect(spawnArgs).toContain("300000");
    });

    it("writes version into daemon state", () => {
      const mockChild = { pid: 9876, unref: vi.fn() };
      const mockSpawn = vi.fn().mockReturnValue(mockChild);
      const mockWriteState = vi.fn();

      startDaemon(
        { version: "2.0.0" },
        {
          getDaemonStatus: () => ({ running: false }),
          spawn: mockSpawn as never,
          writeDaemonState: mockWriteState,
          openSync: vi.fn().mockReturnValue(3),
          closeSync: vi.fn(),
        },
      );

      const state = mockWriteState.mock.calls[0][0];
      expect(state.version).toBe("2.0.0");
    });

    it("passes --smart-schedule off when disabled", () => {
      const mockChild = { pid: 9876, unref: vi.fn() };
      const mockSpawn = vi.fn().mockReturnValue(mockChild);

      startDaemon(
        { smartSchedule: false },
        {
          getDaemonStatus: () => ({ running: false }),
          spawn: mockSpawn as never,
          writeDaemonState: vi.fn(),
          openSync: vi.fn().mockReturnValue(3),
          closeSync: vi.fn(),
        },
      );

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain("--smart-schedule");
      expect(spawnArgs).toContain("off");
    });

    it("does not pass --smart-schedule by default", () => {
      const mockChild = { pid: 9876, unref: vi.fn() };
      const mockSpawn = vi.fn().mockReturnValue(mockChild);

      startDaemon(
        {},
        {
          getDaemonStatus: () => ({ running: false }),
          spawn: mockSpawn as never,
          writeDaemonState: vi.fn(),
          openSync: vi.fn().mockReturnValue(3),
          closeSync: vi.fn(),
        },
      );

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).not.toContain("--smart-schedule");
    });

    it("rotates log file before starting", () => {
      const mockChild = { pid: 9876, unref: vi.fn() };
      const rotateLog = vi.fn();

      startDaemon(
        {},
        {
          getDaemonStatus: () => ({ running: false }),
          spawn: vi.fn().mockReturnValue(mockChild) as never,
          writeDaemonState: vi.fn(),
          openSync: vi.fn().mockReturnValue(3),
          closeSync: vi.fn(),
          rotateLog,
        },
      );

      expect(rotateLog).toHaveBeenCalledWith(
        expect.stringContaining("daemon.log"),
      );
    });

    it("returns error and closes log fd when spawn fails (no pid)", () => {
      const mockChild = { pid: undefined, unref: vi.fn() };
      const mockSpawn = vi.fn().mockReturnValue(mockChild);
      const mockCloseSync = vi.fn();

      const result = startDaemon(
        {},
        {
          getDaemonStatus: () => ({ running: false }),
          spawn: mockSpawn as never,
          writeDaemonState: vi.fn(),
          openSync: vi.fn().mockReturnValue(3),
          closeSync: mockCloseSync,
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to spawn daemon process");
      expect(mockCloseSync).toHaveBeenCalledWith(3);
    });

    it("rejects second start when PID file points to a live process", () => {
      const result = startDaemon(
        {},
        {
          getDaemonStatus: () => ({ running: true, pid: process.pid }),
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Daemon is already running");
      expect(result.pid).toBe(process.pid);
    });
  });

  describe("stopDaemon", () => {
    it("returns error when daemon is not running", async () => {
      const result = await stopDaemon({
        getDaemonStatus: () => ({ running: false }),
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Daemon is not running");
    });

    it("writes stop file and waits for graceful exit", async () => {
      const writeStopFile = vi.fn();
      const removeStopFile = vi.fn();
      let pollCount = 0;

      const result = await stopDaemon({
        getDaemonStatus: () => ({ running: true, pid: 123 }),
        writeStopFile,
        isProcessRunning: () => {
          pollCount++;
          return pollCount < 3; // exits after 2 polls
        },
        removeDaemonState: vi.fn().mockReturnValue(true),
        removeStopFile,
        sleep: vi.fn().mockResolvedValue(undefined),
        kill: vi.fn(),
        log: vi.fn(),
      });

      expect(result.success).toBe(true);
      expect(result.pid).toBe(123);
      expect(writeStopFile).toHaveBeenCalled();
      expect(removeStopFile).toHaveBeenCalled();
    });

    it("sends SIGTERM then SIGKILL after timeout", async () => {
      const kill = vi.fn();
      const forceKill = vi.fn();

      const result = await stopDaemon({
        getDaemonStatus: () => ({ running: true, pid: 456 }),
        writeStopFile: vi.fn(),
        isProcessRunning: () => true, // never exits
        removeDaemonState: vi.fn().mockReturnValue(true),
        removeStopFile: vi.fn(),
        sleep: vi.fn().mockResolvedValue(undefined),
        kill,
        forceKill,
        log: vi.fn(),
      });

      expect(result.success).toBe(false);
      expect(kill).toHaveBeenCalledWith(456);
      expect(forceKill).toHaveBeenCalledWith(456);
    });

    it("calls log callback during graceful wait and force kill", async () => {
      const log = vi.fn();
      const kill = vi.fn();

      await stopDaemon({
        getDaemonStatus: () => ({ running: true, pid: 456 }),
        writeStopFile: vi.fn(),
        isProcessRunning: () => true, // never exits
        removeDaemonState: vi.fn().mockReturnValue(true),
        removeStopFile: vi.fn(),
        sleep: vi.fn().mockResolvedValue(undefined),
        kill,
        forceKill: vi.fn(),
        log,
      });

      expect(log).toHaveBeenCalledWith(
        "Waiting for daemon to stop (PID: 456)...",
      );
      expect(log).toHaveBeenCalledWith("Force-killing daemon...");
    });

    it("escalates to forceKill when process survives SIGTERM", async () => {
      const kill = vi.fn();
      const forceKill = vi.fn();

      await stopDaemon({
        getDaemonStatus: () => ({ running: true, pid: 456 }),
        writeStopFile: vi.fn(),
        isProcessRunning: () => true, // never exits
        removeDaemonState: vi.fn().mockReturnValue(true),
        removeStopFile: vi.fn(),
        sleep: vi.fn().mockResolvedValue(undefined),
        kill,
        forceKill,
        log: vi.fn(),
      });

      expect(kill).toHaveBeenCalledWith(456);
      expect(forceKill).toHaveBeenCalledWith(456);
    });

    it("returns success when process dies after SIGTERM", async () => {
      let killSent = false;
      const result = await stopDaemon({
        getDaemonStatus: () => ({ running: true, pid: 456 }),
        writeStopFile: vi.fn(),
        isProcessRunning: () => {
          // Dies after SIGTERM is sent
          return !killSent;
        },
        removeDaemonState: vi.fn().mockReturnValue(true),
        removeStopFile: vi.fn(),
        sleep: vi.fn().mockResolvedValue(undefined),
        kill: () => {
          killSent = true;
        },
        forceKill: vi.fn(),
        log: vi.fn(),
      });

      expect(result.success).toBe(true);
    });

    it("returns failure when process survives SIGKILL", async () => {
      const result = await stopDaemon({
        getDaemonStatus: () => ({ running: true, pid: 456 }),
        writeStopFile: vi.fn(),
        isProcessRunning: () => true, // immortal process
        removeDaemonState: vi.fn().mockReturnValue(true),
        removeStopFile: vi.fn(),
        sleep: vi.fn().mockResolvedValue(undefined),
        kill: vi.fn(),
        forceKill: vi.fn(),
        log: vi.fn(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to stop daemon (PID: 456)");
    });

    it("handles kill error gracefully", async () => {
      const result = await stopDaemon({
        getDaemonStatus: () => ({ running: true, pid: 789 }),
        writeStopFile: vi.fn(),
        isProcessRunning: () => true,
        removeDaemonState: vi.fn().mockReturnValue(true),
        removeStopFile: vi.fn(),
        sleep: vi.fn().mockResolvedValue(undefined),
        kill: () => {
          throw new Error("ESRCH");
        },
        forceKill: () => {
          throw new Error("ESRCH");
        },
        log: vi.fn(),
      });

      expect(result.success).toBe(false);
    });
  });

  describe("pollingSleep", () => {
    it("resolves early when isInterrupted returns true mid-sleep", async () => {
      let calls = 0;
      const isInterrupted = vi.fn(() => {
        calls++;
        return calls >= 2;
      });
      const start = Date.now();
      await pollingSleep(60_000, { isInterrupted, pollMs: 5 });
      const elapsed = Date.now() - start;
      expect(isInterrupted).toHaveBeenCalled();
      expect(elapsed).toBeLessThan(1_000);
    });
  });

  describe("wakeDaemon", () => {
    it("returns error when daemon is not running", async () => {
      const result = await wakeDaemon({
        getDaemonStatus: () => ({ running: false }),
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("Daemon is not running");
    });

    it("writes wake sentinel and returns success when daemon is running", async () => {
      const writeWakeFile = vi.fn();
      const result = await wakeDaemon({
        getDaemonStatus: () => ({ running: true, pid: 4242 }),
        writeWakeFile,
      });
      expect(result).toEqual({ success: true, pid: 4242 });
      expect(writeWakeFile).toHaveBeenCalledTimes(1);
    });
  });

  describe("runDaemon", () => {
    it("runs daemon loop with deps and removes signal handlers on exit", async () => {
      let calls = 0;
      const log = vi.fn();
      const removeSignal = vi.fn();

      await runDaemon(
        60000,
        { quiet: true },
        {
          runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
          listAccounts: vi
            .fn()
            .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
          sleep: vi.fn().mockResolvedValue(undefined),
          shouldStop: () => {
            calls++;
            return calls > 1;
          },
          log,
          onSignal: vi.fn(),
          removeSignal,
          exit: vi.fn(),
        },
      );

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Daemon started"),
      );
      expect(log).toHaveBeenCalledWith("Daemon stopping...");
      expect(removeSignal).toHaveBeenCalledWith(
        "SIGTERM",
        expect.any(Function),
      );
      expect(removeSignal).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    });

    it("registers signal handlers that clean up and exit", async () => {
      let calls = 0;
      const log = vi.fn();
      const exit = vi.fn();
      const handlers: Record<string, () => void> = {};
      const onSignal = vi.fn((signal: string, handler: () => void) => {
        handlers[signal] = handler;
      });

      // Create stop file so cleanup covers the existsSync(stopPath) branch
      writeFileSync(daemonStopPath(), "");

      await runDaemon(
        60000,
        {},
        {
          runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
          listAccounts: vi.fn().mockReturnValue([]),
          sleep: vi.fn().mockResolvedValue(undefined),
          shouldStop: () => {
            calls++;
            return calls > 1;
          },
          log,
          onSignal,
          removeSignal: vi.fn(),
          exit,
        },
      );

      expect(onSignal).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
      expect(onSignal).toHaveBeenCalledWith("SIGINT", expect.any(Function));

      // Write stop file again for signal handler cleanup path
      writeFileSync(daemonStopPath(), "");
      handlers.SIGTERM();
      expect(log).toHaveBeenCalledWith("Received SIGTERM, shutting down...");
      expect(exit).toHaveBeenCalledWith(0);

      writeFileSync(daemonStopPath(), "");
      handlers.SIGINT();
      expect(log).toHaveBeenCalledWith("Received SIGINT, shutting down...");
    });

    it("clears stale stop file on startup before entering loop", async () => {
      // Simulate a leftover stop file from a crashed daemon
      writeFileSync(daemonStopPath(), "");

      let calls = 0;
      const log = vi.fn();

      await runDaemon(
        60000,
        {},
        {
          runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
          listAccounts: vi
            .fn()
            .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
          sleep: vi.fn().mockResolvedValue(undefined),
          shouldStop: () => {
            calls++;
            return calls > 1;
          },
          log,
          onSignal: vi.fn(),
          removeSignal: vi.fn(),
          exit: vi.fn(),
        },
      );

      // The daemon should have run normally (the stale stop file was cleared)
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Daemon started"),
      );
    });

    it("exits with code 75 after cleanup when daemon loop detects upgrade", async () => {
      const callOrder: string[] = [];
      const log = vi.fn((msg: string) => {
        if (msg === "Daemon stopping...") callOrder.push("cleanup");
      });
      const exit = vi.fn(() => callOrder.push("exit"));
      const removeSignal = vi.fn();

      await runDaemon(
        60000,
        {},
        {
          runPing: vi.fn().mockResolvedValue({ failedHandles: [] }),
          listAccounts: vi
            .fn()
            .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
          sleep: vi.fn().mockResolvedValue(undefined),
          shouldStop: () => false,
          log,
          onSignal: vi.fn(),
          removeSignal,
          exit,
          hasUpgraded: vi.fn().mockReturnValue(true),
        },
      );

      expect(exit).toHaveBeenCalledWith(75);
      expect(callOrder).toEqual(["cleanup", "exit"]);
      expect(removeSignal).toHaveBeenCalledTimes(2);
    });

    it("cleans up even when daemonLoop throws", async () => {
      const log = vi.fn();
      const removeSignal = vi.fn();

      // Write daemon state + stop file so cleanup has something to remove
      writeDaemonState({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        intervalMs: 60000,
        configDir,
      });
      writeFileSync(daemonStopPath(), "");

      await expect(
        runDaemon(
          60000,
          {},
          {
            runPing: vi.fn().mockRejectedValue(new Error("boom")),
            listAccounts: vi
              .fn()
              .mockReturnValue([{ handle: "alice", configDir: "/tmp/alice" }]),
            sleep: vi.fn().mockResolvedValue(undefined),
            shouldStop: () => false,
            log,
            onSignal: vi.fn(),
            removeSignal,
            exit: vi.fn(),
          },
        ),
      ).rejects.toThrow("boom");

      // Cleanup should still have run
      expect(removeSignal).toHaveBeenCalledWith(
        "SIGTERM",
        expect.any(Function),
      );
      expect(removeSignal).toHaveBeenCalledWith("SIGINT", expect.any(Function));
      expect(log).toHaveBeenCalledWith("Daemon stopping...");
      expect(readDaemonState()).toBeNull();
    });
  });
});
