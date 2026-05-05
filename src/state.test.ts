import {
  existsSync,
  mkdirSync,
  readdirSync,
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
    homedir: () => join(tmpdir(), `cc-ping-state-${process.pid}`),
  };
});

const {
  QUOTA_WINDOW_MS,
  loadState,
  saveState,
  recordPing,
  getLastPing,
  getLastPingMeta,
  getWindowReset,
  formatTimeRemaining,
  clearPingState,
  findOrphanHandles,
  pruneOrphanState,
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

    it("returns empty state for corrupt file", () => {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "state.json"), "not json{{{");
      expect(loadState()).toEqual({ lastPing: {} });
    });

    it("quarantines a corrupt state file instead of silently discarding it", () => {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "state.json"), "not json{{{");

      loadState();

      const quarantined = readdirSync(stateDir).filter((f) =>
        f.startsWith("state.json.corrupt"),
      );
      expect(quarantined).toHaveLength(1);
      expect(readFileSync(join(stateDir, quarantined[0]), "utf-8")).toBe(
        "not json{{{",
      );
      expect(existsSync(join(stateDir, "state.json"))).toBe(false);
    });

    it("quarantines state with wrong top-level shape", () => {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "state.json"), JSON.stringify(["array"]));
      expect(loadState()).toEqual({ lastPing: {} });
      expect(
        readdirSync(stateDir).some((f) => f.startsWith("state.json.corrupt")),
      ).toBe(true);
    });

    it("quarantines state with non-string lastPing values", () => {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "state.json"),
        JSON.stringify({ lastPing: { alice: 123 } }),
      );
      expect(loadState()).toEqual({ lastPing: {} });
      expect(
        readdirSync(stateDir).some((f) => f.startsWith("state.json.corrupt")),
      ).toBe(true);
    });

    it("quarantines state with array-typed lastPing", () => {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "state.json"),
        JSON.stringify({ lastPing: ["alice"] }),
      );
      expect(loadState()).toEqual({ lastPing: {} });
      expect(
        readdirSync(stateDir).some((f) => f.startsWith("state.json.corrupt")),
      ).toBe(true);
    });

    it("quarantines state with array-typed lastPingMeta", () => {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "state.json"),
        JSON.stringify({ lastPing: {}, lastPingMeta: [] }),
      );
      expect(loadState()).toEqual({ lastPing: {} });
      expect(
        readdirSync(stateDir).some((f) => f.startsWith("state.json.corrupt")),
      ).toBe(true);
    });

    it("quarantines state with non-object lastPingMeta entry", () => {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "state.json"),
        JSON.stringify({
          lastPing: {},
          lastPingMeta: { alice: "not-an-object" },
        }),
      );
      expect(loadState()).toEqual({ lastPing: {} });
      expect(
        readdirSync(stateDir).some((f) => f.startsWith("state.json.corrupt")),
      ).toBe(true);
    });

    it("quarantines state with malformed lastPingMeta fields", () => {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "state.json"),
        JSON.stringify({
          lastPing: {},
          lastPingMeta: { alice: { costUsd: "not-a-number" } },
        }),
      );
      expect(loadState()).toEqual({ lastPing: {} });
      expect(
        readdirSync(stateDir).some((f) => f.startsWith("state.json.corrupt")),
      ).toBe(true);
    });

    it("quarantines state when JSON parses to null", () => {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "state.json"), "null");
      expect(loadState()).toEqual({ lastPing: {} });
      expect(
        readdirSync(stateDir).some((f) => f.startsWith("state.json.corrupt")),
      ).toBe(true);
    });

    it("quarantines state with null lastPingMeta", () => {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "state.json"),
        JSON.stringify({ lastPing: {}, lastPingMeta: null }),
      );
      expect(loadState()).toEqual({ lastPing: {} });
      expect(
        readdirSync(stateDir).some((f) => f.startsWith("state.json.corrupt")),
      ).toBe(true);
    });
  });

  describe("saveState", () => {
    it("creates directory and writes state", () => {
      saveState({ lastPing: { bob: "2025-06-01T12:00:00.000Z" } });
      const loaded = loadState();
      expect(loaded.lastPing.bob).toBe("2025-06-01T12:00:00.000Z");
    });

    it("writes through a temp file then renames into place", () => {
      const writes: Array<[string, string]> = [];
      const renames: Array<[string, string]> = [];
      saveState(
        { lastPing: { alice: "2026-01-01T00:00:00.000Z" } },
        {
          mkdirSync: () => undefined,
          writeFileSync: (p, data) => {
            writes.push([p, data]);
          },
          renameSync: (from, to) => {
            renames.push([from, to]);
          },
        },
      );

      expect(writes).toHaveLength(1);
      const [writtenPath, payload] = writes[0];
      expect(writtenPath).not.toMatch(/state\.json$/);
      expect(writtenPath).toMatch(/state\.json/);
      expect(JSON.parse(payload).lastPing.alice).toBe(
        "2026-01-01T00:00:00.000Z",
      );

      expect(renames).toHaveLength(1);
      expect(renames[0][0]).toBe(writtenPath);
      expect(renames[0][1]).toMatch(/state\.json$/);
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

    it("returns null when clock drift makes remainingMs exceed quota window", () => {
      const futureTime = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours in the future
      recordPing("alice", futureTime);
      const now = new Date();
      const result = getWindowReset("alice", now);
      expect(result).toBeNull();
    });
  });

  describe("recordPing with metadata", () => {
    const meta = {
      costUsd: 0.003,
      inputTokens: 10,
      outputTokens: 5,
      model: "claude-sonnet-4-20250514",
      sessionId: "sess-1",
    };

    it("records metadata alongside timestamp", () => {
      const ts = new Date("2025-03-15T10:00:00.000Z");
      recordPing("alice", ts, meta);
      const state = loadState();
      expect(state.lastPing.alice).toBe("2025-03-15T10:00:00.000Z");
      expect(state.lastPingMeta?.alice).toEqual(meta);
    });

    it("records ping without metadata (backward compat)", () => {
      recordPing("bob", new Date("2025-03-15T10:00:00.000Z"));
      const state = loadState();
      expect(state.lastPing.bob).toBe("2025-03-15T10:00:00.000Z");
      expect(state.lastPingMeta?.bob).toBeUndefined();
    });

    it("overwrites previous metadata for same handle", () => {
      const ts = new Date("2025-03-15T10:00:00.000Z");
      recordPing("alice", ts, meta);
      const updated = { ...meta, costUsd: 0.005 };
      recordPing("alice", new Date("2025-03-15T11:00:00.000Z"), updated);
      const state = loadState();
      expect(state.lastPingMeta?.alice).toEqual(updated);
    });

    it("loads state file without lastPingMeta field", () => {
      saveState({ lastPing: { old: "2025-01-01T00:00:00.000Z" } });
      const state = loadState();
      expect(state.lastPing.old).toBe("2025-01-01T00:00:00.000Z");
      expect(state.lastPingMeta).toBeUndefined();
    });
  });

  describe("getLastPingMeta", () => {
    it("returns null for unknown handle", () => {
      expect(getLastPingMeta("unknown")).toBeNull();
    });

    it("returns PingMeta for known handle", () => {
      const meta = {
        costUsd: 0.003,
        inputTokens: 10,
        outputTokens: 5,
        model: "claude-sonnet-4-20250514",
        sessionId: "sess-1",
      };
      recordPing("alice", new Date("2025-03-15T10:00:00.000Z"), meta);
      const result = getLastPingMeta("alice");
      expect(result).toEqual(meta);
    });
  });

  describe("clearPingState", () => {
    const meta = {
      costUsd: 0.003,
      inputTokens: 10,
      outputTokens: 5,
      model: "claude-sonnet-4-20250514",
      sessionId: "sess-1",
    };

    it("removes timestamp and metadata for handle", () => {
      recordPing("alice", new Date("2025-03-15T10:00:00.000Z"), meta);
      expect(clearPingState("alice")).toBe(true);
      const state = loadState();
      expect(state.lastPing.alice).toBeUndefined();
      expect(state.lastPingMeta?.alice).toBeUndefined();
    });

    it("removes timestamp when no metadata exists", () => {
      recordPing("bob", new Date("2025-03-15T10:00:00.000Z"));
      expect(clearPingState("bob")).toBe(true);
      expect(loadState().lastPing.bob).toBeUndefined();
    });

    it("returns false for unknown handle", () => {
      recordPing("alice", new Date("2025-03-15T10:00:00.000Z"));
      expect(clearPingState("ghost")).toBe(false);
      expect(loadState().lastPing.alice).toBe("2025-03-15T10:00:00.000Z");
    });

    it("removes only metadata when timestamp already absent", () => {
      saveState({
        lastPing: {},
        lastPingMeta: { orphan: meta },
      });
      expect(clearPingState("orphan")).toBe(true);
      expect(loadState().lastPingMeta?.orphan).toBeUndefined();
    });
  });

  describe("findOrphanHandles", () => {
    it("returns empty when no state exists", () => {
      expect(findOrphanHandles(["alice"])).toEqual([]);
    });

    it("returns handles not in active set", () => {
      recordPing("alice", new Date("2025-03-15T10:00:00.000Z"));
      recordPing("bob", new Date("2025-03-15T10:00:00.000Z"));
      recordPing("charlie", new Date("2025-03-15T10:00:00.000Z"));
      const orphans = findOrphanHandles(["alice"]);
      expect(orphans.sort()).toEqual(["bob", "charlie"]);
    });

    it("finds orphans present only in metadata", () => {
      saveState({
        lastPing: { alice: "2025-03-15T10:00:00.000Z" },
        lastPingMeta: {
          alice: {
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            model: "m",
            sessionId: "s",
          },
          stranded: {
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            model: "m",
            sessionId: "s",
          },
        },
      });
      expect(findOrphanHandles(["alice"])).toEqual(["stranded"]);
    });
  });

  describe("pruneOrphanState", () => {
    it("returns empty and writes nothing when no orphans", () => {
      recordPing("alice", new Date("2025-03-15T10:00:00.000Z"));
      expect(pruneOrphanState(["alice"])).toEqual([]);
      expect(loadState().lastPing.alice).toBe("2025-03-15T10:00:00.000Z");
    });

    it("removes orphan entries from lastPing and lastPingMeta", () => {
      const meta = {
        costUsd: 0.003,
        inputTokens: 10,
        outputTokens: 5,
        model: "m",
        sessionId: "s",
      };
      recordPing("alice", new Date("2025-03-15T10:00:00.000Z"), meta);
      recordPing("ghost", new Date("2025-03-10T10:00:00.000Z"), meta);
      const removed = pruneOrphanState(["alice"]);
      expect(removed).toEqual(["ghost"]);
      const state = loadState();
      expect(state.lastPing.ghost).toBeUndefined();
      expect(state.lastPingMeta?.ghost).toBeUndefined();
      expect(state.lastPing.alice).toBeDefined();
      expect(state.lastPingMeta?.alice).toBeDefined();
    });

    it("handles state without lastPingMeta field", () => {
      saveState({ lastPing: { ghost: "2025-03-15T10:00:00.000Z" } });
      expect(pruneOrphanState([])).toEqual(["ghost"]);
      expect(loadState().lastPing.ghost).toBeUndefined();
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
