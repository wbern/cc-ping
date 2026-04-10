import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => join(tmpdir(), `cc-ping-history-${process.pid}`),
  };
});

const { appendHistoryEntry, readHistory, formatHistoryEntry } = await import(
  "./history.js"
);

describe("appendHistoryEntry", () => {
  const configDir = join(
    tmpdir(),
    `cc-ping-history-${process.pid}`,
    ".config",
    "cc-ping",
  );

  beforeEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("appends a successful ping entry to history file", () => {
    appendHistoryEntry({
      timestamp: "2025-01-01T00:00:00.000Z",
      handle: "alice",
      success: true,
      durationMs: 150,
    });

    const entries = readHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      timestamp: "2025-01-01T00:00:00.000Z",
      handle: "alice",
      success: true,
      durationMs: 150,
    });
  });

  it("appends multiple entries preserving order", () => {
    appendHistoryEntry({
      timestamp: "2025-01-01T00:00:00.000Z",
      handle: "alice",
      success: true,
      durationMs: 100,
    });
    appendHistoryEntry({
      timestamp: "2025-01-01T01:00:00.000Z",
      handle: "bob",
      success: false,
      durationMs: 200,
      error: "timed out",
    });

    const entries = readHistory();
    expect(entries).toHaveLength(2);
    expect(entries[0].handle).toBe("alice");
    expect(entries[1].handle).toBe("bob");
    expect(entries[1].error).toBe("timed out");
  });

  it("returns empty array when no history file exists", () => {
    const entries = readHistory();
    expect(entries).toEqual([]);
  });

  it("returns empty array when history file is empty", () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "history.jsonl"), "");
    const entries = readHistory();
    expect(entries).toEqual([]);
  });

  it("returns only the last N entries when limit is specified", () => {
    for (let i = 0; i < 5; i++) {
      appendHistoryEntry({
        timestamp: `2025-01-01T0${i}:00:00.000Z`,
        handle: `acct-${i}`,
        success: true,
        durationMs: 100,
      });
    }

    const entries = readHistory(3);
    expect(entries).toHaveLength(3);
    expect(entries[0].handle).toBe("acct-2");
    expect(entries[2].handle).toBe("acct-4");
  });
});

describe("formatHistoryEntry", () => {
  it("formats a successful entry with raw timestamp by default", () => {
    const line = formatHistoryEntry({
      timestamp: "2025-01-01T00:00:00.000Z",
      handle: "alice",
      success: true,
      durationMs: 150,
    });
    expect(line).toContain("alice");
    expect(line).toContain("ok");
    expect(line).toContain("150ms");
    expect(line).toContain("2025-01-01");
  });

  it("shows relative time when now is provided", () => {
    const line = formatHistoryEntry(
      {
        timestamp: "2025-01-01T00:00:00.000Z",
        handle: "alice",
        success: true,
        durationMs: 150,
      },
      new Date("2025-01-01T02:30:00.000Z"),
    );
    expect(line).toContain("2h 30m ago");
    expect(line).not.toContain("2025-01-01");
  });

  it("formats a failed entry with error", () => {
    const line = formatHistoryEntry({
      timestamp: "2025-01-01T00:00:00.000Z",
      handle: "bob",
      success: false,
      durationMs: 200,
      error: "timed out",
    });
    expect(line).toContain("bob");
    expect(line).toContain("FAIL");
    expect(line).toContain("timed out");
  });
});
