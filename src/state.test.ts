import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => join(tmpdir(), `cc-ping-state-${process.pid}`),
  };
});

const {
  QUOTA_WINDOW_MS,
  loadState,
  saveState,
  recordPing,
  getLastPing,
  getWindowReset,
  formatTimeRemaining,
} = await import("./state.js");

describe("state", () => {
  const stateDir = join(
    tmpdir(),
    `cc-ping-state-${process.pid}`,
    ".config",
    "cc-ping",
  );

  beforeEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  describe("loadState", () => {
    it("returns empty state when no file exists", () => {
      expect(loadState()).toEqual({ lastPing: {} });
    });

    it("loads saved state", () => {
      const state = { lastPing: { alice: "2025-01-01T00:00:00.000Z" } };
      saveState(state);
      expect(loadState()).toEqual(state);
    });
  });

  describe("saveState", () => {
    it("creates directory and writes state", () => {
      saveState({ lastPing: { bob: "2025-06-01T12:00:00.000Z" } });
      const loaded = loadState();
      expect(loaded.lastPing.bob).toBe("2025-06-01T12:00:00.000Z");
    });
  });

  describe("recordPing", () => {
    it("records a ping with explicit timestamp", () => {
      const ts = new Date("2025-03-15T10:00:00.000Z");
      recordPing("alice", ts);
      const state = loadState();
      expect(state.lastPing.alice).toBe("2025-03-15T10:00:00.000Z");
    });

    it("records a ping with default timestamp", () => {
      const before = new Date();
      recordPing("bob");
      const after = new Date();
      const state = loadState();
      const recorded = new Date(state.lastPing.bob).getTime();
      expect(recorded).toBeGreaterThanOrEqual(before.getTime());
      expect(recorded).toBeLessThanOrEqual(after.getTime());
    });

    it("overwrites previous ping for same handle", () => {
      recordPing("alice", new Date("2025-01-01T00:00:00.000Z"));
      recordPing("alice", new Date("2025-06-01T00:00:00.000Z"));
      const state = loadState();
      expect(state.lastPing.alice).toBe("2025-06-01T00:00:00.000Z");
    });
  });

  describe("getLastPing", () => {
    it("returns null for unknown handle", () => {
      expect(getLastPing("unknown")).toBeNull();
    });

    it("returns Date for known handle", () => {
      recordPing("alice", new Date("2025-03-15T10:00:00.000Z"));
      const result = getLastPing("alice");
      expect(result).toBeInstanceOf(Date);
      expect(result?.toISOString()).toBe("2025-03-15T10:00:00.000Z");
    });
  });

  describe("getWindowReset", () => {
    it("returns null for unknown handle", () => {
      expect(getWindowReset("unknown")).toBeNull();
    });

    it("returns null when window has expired", () => {
      const pingTime = new Date("2025-01-01T00:00:00.000Z");
      recordPing("alice", pingTime);
      const now = new Date(pingTime.getTime() + QUOTA_WINDOW_MS + 1);
      expect(getWindowReset("alice", now)).toBeNull();
    });

    it("returns reset info for active window", () => {
      const pingTime = new Date("2025-01-01T00:00:00.000Z");
      recordPing("alice", pingTime);
      const now = new Date(pingTime.getTime() + 60 * 60 * 1000); // 1 hour later
      const result = getWindowReset("alice", now);
      expect(result).not.toBeNull();
      expect(result?.resetAt.toISOString()).toBe("2025-01-01T05:00:00.000Z");
      expect(result?.remainingMs).toBe(4 * 60 * 60 * 1000); // 4 hours
    });
  });

  describe("formatTimeRemaining", () => {
    it("returns 'expired' for zero", () => {
      expect(formatTimeRemaining(0)).toBe("expired");
    });

    it("returns 'expired' for negative values", () => {
      expect(formatTimeRemaining(-1000)).toBe("expired");
    });

    it("formats minutes only", () => {
      expect(formatTimeRemaining(15 * 60 * 1000)).toBe("15m");
    });

    it("formats hours and minutes", () => {
      expect(formatTimeRemaining(2 * 60 * 60 * 1000 + 30 * 60 * 1000)).toBe(
        "2h 30m",
      );
    });

    it("rounds up partial minutes", () => {
      expect(formatTimeRemaining(90_000)).toBe("2m"); // 1.5 min rounds up
    });

    it("formats exactly 5 hours", () => {
      expect(formatTimeRemaining(QUOTA_WINDOW_MS)).toBe("5h 0m");
    });
  });
});
