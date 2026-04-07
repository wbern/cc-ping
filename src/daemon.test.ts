import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  runDaemon,
  daemonPidPath,
  daemonLogPath,
  daemonStopPath,
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

  describe("getDaemonStatus", () => {
    it("returns not running when no PID file exists", () => {
      const status = getDaemonStatus();
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

      const status = getDaemonStatus();
      expect(status.running).toBe(true);
      expect(status.pid).toBe(process.pid);
      expect(status.intervalMs).toBe(300000);
      expect(status.uptime).toBeDefined();
    });

    it("cleans stale PID file and returns not running", () => {
      writeDaemonState({
        pid: NONEXISTENT_PID,
        startedAt: new Date().toISOString(),
        intervalMs: 300000,
        configDir,
      });

      const status = getDaemonStatus();
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

      const status = getDaemonStatus();
      expect(status.uptime).toMatch(/\d+m \d+s/);
    });

    it("shows seconds-only uptime for very recent start", () => {
      writeDaemonState({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        intervalMs: 300000,
        configDir,
      });

      const status = getDaemonStatus();
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

      const status = getDaemonStatus();
      expect(status.uptime).toMatch(/\d+h \d+m \d+s/);
    });
  });

  describe("daemonLoop", () => {
    it("pings accounts and stops when shouldStop returns true", async () => {
      let calls = 0;
      const deps = {
        runPing: vi.fn().mockResolvedValue(0),
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
        runPing: vi.fn().mockResolvedValue(0),
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
        { parallel: false, quiet: true, bell: true, notify: true },
      );
    });

    it("sleeps for interval between pings", async () => {
      let calls = 0;
      const deps = {
        runPing: vi.fn().mockResolvedValue(0),
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
        runPing: vi.fn().mockResolvedValue(0),
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
          return 0;
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

      const result = startDaemon(
        { interval: "60" },
        {
          getDaemonStatus: () => ({ running: false }),
          spawn: mockSpawn as never,
          writeDaemonState: mockWriteState,
          openSync: vi.fn().mockReturnValue(3),
        },
      );

      expect(result.success).toBe(true);
      expect(result.pid).toBe(9876);
      expect(mockChild.unref).toHaveBeenCalled();
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
        },
      );

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain("--quiet");
      expect(spawnArgs).toContain("--bell");
      expect(spawnArgs).toContain("--notify");
      expect(spawnArgs).toContain("--interval-ms");
      expect(spawnArgs).toContain("300000");
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
      });

      expect(result.success).toBe(true);
      expect(result.pid).toBe(123);
      expect(writeStopFile).toHaveBeenCalled();
      expect(removeStopFile).toHaveBeenCalled();
    });

    it("force kills after timeout", async () => {
      const kill = vi.fn();

      const result = await stopDaemon({
        getDaemonStatus: () => ({ running: true, pid: 456 }),
        writeStopFile: vi.fn(),
        isProcessRunning: () => true, // never exits gracefully
        removeDaemonState: vi.fn().mockReturnValue(true),
        removeStopFile: vi.fn(),
        sleep: vi.fn().mockResolvedValue(undefined),
        kill,
      });

      expect(result.success).toBe(true);
      expect(kill).toHaveBeenCalledWith(456);
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
      });

      expect(result.success).toBe(true);
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
          runPing: vi.fn().mockResolvedValue(0),
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
          runPing: vi.fn().mockResolvedValue(0),
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
  });
});
