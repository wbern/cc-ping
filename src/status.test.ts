import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => join(tmpdir(), `cc-ping-status-${process.pid}`),
  };
});

const { recordPing } = await import("./state.js");
const { getAccountStatuses, formatStatusLine } = await import("./status.js");

describe("getAccountStatuses", () => {
  const stateDir = join(
    tmpdir(),
    `cc-ping-status-${process.pid}`,
    ".config",
    "cc-ping",
  );

  beforeEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns unknown status for accounts never pinged", () => {
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];
    const statuses = getAccountStatuses(accounts);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toEqual({
      handle: "alice",
      configDir: "/tmp/alice",
      lastPing: null,
      windowStatus: "unknown",
      timeUntilReset: null,
      lastCostUsd: null,
      lastTokens: null,
    });
  });

  it("returns active status for recently pinged account", () => {
    const pingTime = new Date("2025-01-01T00:00:00.000Z");
    recordPing("bob", pingTime);
    const now = new Date("2025-01-01T01:00:00.000Z"); // 1 hour later
    const accounts = [{ handle: "bob", configDir: "/tmp/bob" }];
    const statuses = getAccountStatuses(accounts, now);
    expect(statuses[0]).toEqual({
      handle: "bob",
      configDir: "/tmp/bob",
      lastPing: "2025-01-01T00:00:00.000Z",
      windowStatus: "active",
      timeUntilReset: "4h 0m",
      lastCostUsd: null,
      lastTokens: null,
    });
  });

  it("returns expired status when window has passed", () => {
    const pingTime = new Date("2025-01-01T00:00:00.000Z");
    recordPing("charlie", pingTime);
    const now = new Date("2025-01-01T06:00:00.000Z"); // 6 hours later
    const accounts = [{ handle: "charlie", configDir: "/tmp/charlie" }];
    const statuses = getAccountStatuses(accounts, now);
    expect(statuses[0]).toEqual({
      handle: "charlie",
      configDir: "/tmp/charlie",
      lastPing: "2025-01-01T00:00:00.000Z",
      windowStatus: "expired",
      timeUntilReset: null,
      lastCostUsd: null,
      lastTokens: null,
    });
  });

  it("returns empty array for no accounts", () => {
    const statuses = getAccountStatuses([]);
    expect(statuses).toEqual([]);
  });

  it("handles multiple accounts with mixed statuses", () => {
    recordPing("active-acct", new Date("2025-01-01T03:00:00.000Z"));
    recordPing("expired-acct", new Date("2024-12-31T22:00:00.000Z"));
    const now = new Date("2025-01-01T04:00:00.000Z");
    const accounts = [
      { handle: "active-acct", configDir: "/tmp/active" },
      { handle: "expired-acct", configDir: "/tmp/expired" },
      { handle: "never-pinged", configDir: "/tmp/never" },
    ];
    const statuses = getAccountStatuses(accounts, now);
    expect(statuses[0].windowStatus).toBe("active");
    expect(statuses[1].windowStatus).toBe("expired");
    expect(statuses[2].windowStatus).toBe("unknown");
  });

  it("includes cost and tokens when metadata exists", () => {
    const pingTime = new Date("2025-01-01T00:00:00.000Z");
    recordPing("meta-acct", pingTime, {
      costUsd: 0.003,
      inputTokens: 10,
      outputTokens: 5,
      model: "claude-sonnet-4-20250514",
      sessionId: "sess-1",
    });
    const now = new Date("2025-01-01T01:00:00.000Z");
    const accounts = [{ handle: "meta-acct", configDir: "/tmp/meta" }];
    const statuses = getAccountStatuses(accounts, now);
    expect(statuses[0].lastCostUsd).toBe(0.003);
    expect(statuses[0].lastTokens).toBe(15);
  });

  it("sets duplicateOf when duplicates map is provided", () => {
    const accounts = [
      { handle: "bernting", configDir: "/tmp/bernting" },
      { handle: "bernting.se", configDir: "/tmp/bernting.se" },
    ];
    const dupes = new Map([
      [
        "uuid-same",
        { handles: ["bernting", "bernting.se"], email: "w@bernting.se" },
      ],
    ]);
    const statuses = getAccountStatuses(accounts, new Date(), dupes);
    expect(statuses[0].duplicateOf).toBe("bernting.se");
    expect(statuses[1].duplicateOf).toBe("bernting");
  });

  it("returns null for cost and tokens when no metadata", () => {
    const pingTime = new Date("2025-01-01T00:00:00.000Z");
    recordPing("no-meta", pingTime);
    const now = new Date("2025-01-01T01:00:00.000Z");
    const accounts = [{ handle: "no-meta", configDir: "/tmp/no-meta" }];
    const statuses = getAccountStatuses(accounts, now);
    expect(statuses[0].lastCostUsd).toBeNull();
    expect(statuses[0].lastTokens).toBeNull();
  });
});

describe("formatStatusLine", () => {
  it("formats an active account", () => {
    const line = formatStatusLine({
      handle: "alice",
      configDir: "/tmp/alice",
      lastPing: "2025-01-01T00:00:00.000Z",
      windowStatus: "active",
      timeUntilReset: "4h 0m",
      lastCostUsd: null,
      lastTokens: null,
    });
    expect(line).toContain("alice");
    expect(line).toContain("active");
    expect(line).toContain("4h 0m");
  });

  it("formats an expired account", () => {
    const line = formatStatusLine({
      handle: "bob",
      configDir: "/tmp/bob",
      lastPing: "2025-01-01T00:00:00.000Z",
      windowStatus: "expired",
      timeUntilReset: null,
      lastCostUsd: null,
      lastTokens: null,
    });
    expect(line).toContain("bob");
    expect(line).toContain("expired");
    expect(line).not.toContain("resets in");
  });

  it("formats an unknown account", () => {
    const line = formatStatusLine({
      handle: "charlie",
      configDir: "/tmp/charlie",
      lastPing: null,
      windowStatus: "unknown",
      timeUntilReset: null,
      lastCostUsd: null,
      lastTokens: null,
    });
    expect(line).toContain("charlie");
    expect(line).toContain("unknown");
    expect(line).toContain("never");
  });

  it("includes cost info when available", () => {
    const line = formatStatusLine({
      handle: "alice",
      configDir: "/tmp/alice",
      lastPing: "2025-01-01T00:00:00.000Z",
      windowStatus: "active",
      timeUntilReset: "4h 0m",
      lastCostUsd: 0.003,
      lastTokens: 15,
    });
    expect(line).toContain("$0.0030");
    expect(line).toContain("15 tok");
  });

  it("shows duplicate indicator when duplicateOf is set", () => {
    const line = formatStatusLine({
      handle: "bernting.se",
      configDir: "/tmp/bernting.se",
      lastPing: null,
      windowStatus: "unknown",
      timeUntilReset: null,
      lastCostUsd: null,
      lastTokens: null,
      duplicateOf: "bernting",
    });
    expect(line).toContain("[duplicate of bernting]");
  });

  it("shows no duplicate indicator when duplicateOf is undefined", () => {
    const line = formatStatusLine({
      handle: "alice",
      configDir: "/tmp/alice",
      lastPing: null,
      windowStatus: "unknown",
      timeUntilReset: null,
      lastCostUsd: null,
      lastTokens: null,
    });
    expect(line).not.toContain("duplicate");
  });
});
