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

vi.mock("./config.js", () => ({
  listAccounts: vi.fn(() => []),
  loadConfig: vi.fn(() => ({ accounts: [] })),
  saveConfig: vi.fn(),
}));

vi.mock("./identity.js", () => ({
  findDuplicates: vi.fn(() => new Map()),
}));

const { listAccounts } = await import("./config.js");
const { findDuplicates } = await import("./identity.js");
const { recordPing } = await import("./state.js");

import type { DeferInfo } from "./status.js";

const {
  getAccountStatuses,
  formatLocalHour,
  formatStatusLine,
  formatTimeAgo,
  printAccountTable,
  censorHandle,
} = await import("./status.js");

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

  it("returns needs-ping status when window has passed", () => {
    const pingTime = new Date("2025-01-01T00:00:00.000Z");
    recordPing("charlie", pingTime);
    const now = new Date("2025-01-01T06:00:00.000Z"); // 6 hours later
    const accounts = [{ handle: "charlie", configDir: "/tmp/charlie" }];
    const statuses = getAccountStatuses(accounts, now);
    expect(statuses[0]).toEqual({
      handle: "charlie",
      configDir: "/tmp/charlie",
      lastPing: "2025-01-01T00:00:00.000Z",
      windowStatus: "needs ping",
      timeUntilReset: null,
      lastCostUsd: null,
      lastTokens: null,
    });
  });

  it("returns deferred status with ping hour when account is in deferred map", () => {
    const pingTime = new Date("2025-01-01T00:00:00.000Z");
    recordPing("deferred-acct", pingTime);
    const now = new Date("2025-01-01T06:00:00.000Z"); // window expired
    const accounts = [{ handle: "deferred-acct", configDir: "/tmp/deferred" }];
    const deferred = new Map([
      ["deferred-acct", { optimalPingHour: 9, peakStart: 12, peakEnd: 17 }],
    ]);
    const statuses = getAccountStatuses(accounts, now, undefined, deferred);
    expect(statuses[0].windowStatus).toBe("deferred");
    expect(statuses[0].deferUntilUtcHour).toBe(9);
    expect(statuses[0].peakStartHour).toBe(12);
    expect(statuses[0].peakEndHour).toBe(17);
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
    expect(statuses[1].windowStatus).toBe("needs ping");
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

  it("returns deferred status with reason when account is covered by recent activity", () => {
    const pingTime = new Date("2025-01-01T00:00:00.000Z");
    recordPing("covered-acct", pingTime);
    const now = new Date("2025-01-01T06:00:00.000Z"); // window expired
    const accounts = [{ handle: "covered-acct", configDir: "/tmp/covered" }];
    const coveredHandles = new Map<string, DeferInfo | null>([
      ["covered-acct", { optimalPingHour: 14, peakStart: 17, peakEnd: 22 }],
    ]);
    const statuses = getAccountStatuses(
      accounts,
      now,
      undefined,
      undefined,
      coveredHandles,
    );
    expect(statuses[0].windowStatus).toBe("deferred");
    expect(statuses[0].deferReason).toBe(
      "window active from recent Claude Code usage",
    );
    expect(statuses[0].deferUntilUtcHour).toBe(14);
    expect(statuses[0].peakStartHour).toBe(17);
    expect(statuses[0].peakEndHour).toBe(22);
    expect(statuses[0].timeUntilReset).toBeNull();
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
  it("shows last ping as relative time when now is provided", () => {
    const line = formatStatusLine(
      {
        handle: "alice",
        configDir: "/tmp/alice",
        lastPing: "2025-01-01T00:00:00.000Z",
        windowStatus: "active",
        timeUntilReset: "4h 0m",
        lastCostUsd: null,
        lastTokens: null,
      },
      { now: new Date("2025-01-01T02:30:00.000Z") },
    );
    const lines = line.split("\n");
    expect(lines[0]).toContain("alice");
    expect(lines[0]).toContain("active");
    expect(line).toContain("last ping: about 3 hours ago");
    expect(line).toContain("resets in 4h 0m");
  });

  it("formats a needs-ping account", () => {
    const line = formatStatusLine({
      handle: "bob",
      configDir: "/tmp/bob",
      lastPing: "2025-01-01T00:00:00.000Z",
      windowStatus: "needs ping",
      timeUntilReset: null,
      lastCostUsd: null,
      lastTokens: null,
    });
    expect(line).toContain("bob");
    expect(line).toContain("needs ping");
    expect(line).not.toContain("resets in");
  });

  it("shows daemon's next-ping time for needs-ping accounts", () => {
    const line = formatStatusLine(
      {
        handle: "bob",
        configDir: "/tmp/bob",
        lastPing: "2025-01-01T00:00:00.000Z",
        windowStatus: "needs ping",
        timeUntilReset: null,
        lastCostUsd: null,
        lastTokens: null,
      },
      { daemonNextPingIn: "4h 52m" },
    );
    expect(line).toContain("next ping in 4h 52m");
  });

  it("hints at the wake command for needs-ping accounts when daemon is running", () => {
    const line = formatStatusLine(
      {
        handle: "bob",
        configDir: "/tmp/bob",
        lastPing: "2025-01-01T00:00:00.000Z",
        windowStatus: "needs ping",
        timeUntilReset: null,
        lastCostUsd: null,
        lastTokens: null,
      },
      { daemonNextPingIn: "4h 52m" },
    );
    expect(line).toContain("cc-ping wake");
    expect(line).not.toContain("cc-ping ping bob");
  });

  it("omits wake hint when daemon is not running", () => {
    const line = formatStatusLine({
      handle: "bob",
      configDir: "/tmp/bob",
      lastPing: "2025-01-01T00:00:00.000Z",
      windowStatus: "needs ping",
      timeUntilReset: null,
      lastCostUsd: null,
      lastTokens: null,
    });
    expect(line).not.toContain("cc-ping wake");
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

  it("shows daemon's next-ping cadence for activity-covered accounts (no smart annotation)", () => {
    const line = formatStatusLine(
      {
        handle: "alice",
        configDir: "/tmp/alice",
        lastPing: "2025-01-01T00:00:00.000Z",
        windowStatus: "deferred",
        timeUntilReset: null,
        lastCostUsd: null,
        lastTokens: null,
        deferReason: "window active from recent Claude Code usage",
        deferUntilUtcHour: 14,
        peakStartHour: 17,
        peakEndHour: 22,
      },
      {
        now: new Date("2025-01-01T11:00:00.000Z"),
        daemonNextPingIn: "4h 12m",
      },
    );
    expect(line).toContain("window active from recent Claude Code usage");
    expect(line).toContain("next ping in 4h 12m");
    expect(line).not.toContain("smart-scheduled");
    expect(line).not.toContain("peak:");
  });

  it("omits next-ping line for activity-covered accounts when daemon is not running", () => {
    const line = formatStatusLine(
      {
        handle: "alice",
        configDir: "/tmp/alice",
        lastPing: "2025-01-01T00:00:00.000Z",
        windowStatus: "deferred",
        timeUntilReset: null,
        lastCostUsd: null,
        lastTokens: null,
        deferReason: "window active from recent Claude Code usage",
        deferUntilUtcHour: 14,
      },
      { now: new Date("2025-01-01T11:00:00.000Z") },
    );
    expect(line).toContain("window active from recent Claude Code usage");
    expect(line).not.toContain("next ping");
  });

  it("annotates a smart-scheduled deferred account (no now)", () => {
    const line = formatStatusLine({
      handle: "eve",
      configDir: "/tmp/eve",
      lastPing: "2025-01-01T00:00:00.000Z",
      windowStatus: "deferred",
      timeUntilReset: null,
      lastCostUsd: null,
      lastTokens: null,
      deferUntilUtcHour: 9,
    });
    expect(line).toContain("eve");
    expect(line).toContain("deferred");
    expect(line).toContain("next ping at 9:00 UTC");
    expect(line).toContain("smart-scheduled");
  });

  it("annotates a smart-scheduled deferred account when now is provided", () => {
    const line = formatStatusLine(
      {
        handle: "eve",
        configDir: "/tmp/eve",
        lastPing: "2025-01-01T00:00:00.000Z",
        windowStatus: "deferred",
        timeUntilReset: null,
        lastCostUsd: null,
        lastTokens: null,
        deferUntilUtcHour: 9,
      },
      { now: new Date("2025-01-01T06:00:00.000Z") },
    );
    expect(line).toContain("next ping in about 3 hours");
    expect(line).toContain("smart-scheduled");
    expect(line).not.toContain("peak");
    expect(line).not.toContain("UTC");
  });

  it("includes peak window in smart-schedule annotation when available", () => {
    const line = formatStatusLine({
      handle: "eve",
      configDir: "/tmp/eve",
      lastPing: "2025-01-01T00:00:00.000Z",
      windowStatus: "deferred",
      timeUntilReset: null,
      lastCostUsd: null,
      lastTokens: null,
      deferUntilUtcHour: 16,
      peakStartHour: 19,
      peakEndHour: 0,
    });
    expect(line).toContain("next ping at 16:00 UTC");
    expect(line).toContain("smart-scheduled");
    expect(line).toContain("peak: 19-0 UTC");
  });

  it("formats a deferred account without scheduled time when hour is undefined", () => {
    const line = formatStatusLine({
      handle: "eve",
      configDir: "/tmp/eve",
      lastPing: "2025-01-01T00:00:00.000Z",
      windowStatus: "deferred",
      timeUntilReset: null,
      lastCostUsd: null,
      lastTokens: null,
    });
    expect(line).toContain("deferred");
    expect(line).not.toContain("scheduled");
  });

  it("does not include cost info even when available", () => {
    const line = formatStatusLine({
      handle: "alice",
      configDir: "/tmp/alice",
      lastPing: "2025-01-01T00:00:00.000Z",
      windowStatus: "active",
      timeUntilReset: "4h 0m",
      lastCostUsd: 0.003,
      lastTokens: 15,
    });
    expect(line).not.toContain("$");
    expect(line).not.toContain("tok");
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

  it("censors handle when censor option is true", () => {
    const line = formatStatusLine(
      {
        handle: "qvazzler@gmail.com",
        configDir: "/tmp/q",
        lastPing: null,
        windowStatus: "unknown",
        timeUntilReset: null,
        lastCostUsd: null,
        lastTokens: null,
      },
      { censor: true },
    );
    expect(line).toContain("q·······@g····.com");
    expect(line).not.toContain("qvazzler");
  });

  it("censors duplicateOf when censor option is true", () => {
    const line = formatStatusLine(
      {
        handle: "bernting.se",
        configDir: "/tmp/b",
        lastPing: null,
        windowStatus: "unknown",
        timeUntilReset: null,
        lastCostUsd: null,
        lastTokens: null,
        duplicateOf: "bernting",
      },
      { censor: true },
    );
    expect(line).toContain("[duplicate of b·······]");
    expect(line).not.toContain("[duplicate of bernting]");
  });
});

describe("censorHandle", () => {
  it("masks email handles keeping first char and TLD", () => {
    expect(censorHandle("qvazzler@gmail.com")).toBe("q·······@g····.com");
  });

  it("masks domain-style handles keeping first char and TLD", () => {
    expect(censorHandle("bernting.se")).toBe("b·······.se");
  });

  it("masks short handles", () => {
    expect(censorHandle("akka.io")).toBe("a···.io");
  });

  it("returns single-char handles as-is", () => {
    expect(censorHandle("a")).toBe("a");
  });
});

describe("formatTimeAgo", () => {
  const base = "2025-01-01T12:00:00.000Z";

  it("returns a past-tense distance string", () => {
    const result = formatTimeAgo(base, new Date("2025-01-01T15:00:00.000Z"));
    expect(result).toContain("ago");
    expect(result).toContain("hour");
  });

  it("scales from minutes to days", () => {
    const minutes = formatTimeAgo(base, new Date("2025-01-01T12:45:00.000Z"));
    expect(minutes).toContain("ago");
    const days = formatTimeAgo(base, new Date("2025-01-04T12:00:00.000Z"));
    expect(days).toContain("day");
    expect(days).toContain("ago");
  });
});

describe("formatLocalHour", () => {
  const ref = new Date("2025-01-01T12:00:00.000Z");

  function expectedLocalHour(utcHour: number): string {
    const d = new Date(ref);
    d.setUTCHours(utcHour, 0, 0, 0);
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  it("converts UTC hours to locale-formatted local time", () => {
    const offset = ref.getTimezoneOffset();
    const threeAmUtc = ((3 + offset / 60 + 24) % 24) | 0;
    const threePmUtc = ((15 + offset / 60 + 24) % 24) | 0;
    expect(formatLocalHour(threeAmUtc, ref)).toBe(
      expectedLocalHour(threeAmUtc),
    );
    expect(formatLocalHour(threePmUtc, ref)).toBe(
      expectedLocalHour(threePmUtc),
    );
  });

  it("handles midnight and noon", () => {
    const offset = ref.getTimezoneOffset();
    const midnightUtc = ((0 + offset / 60 + 24) % 24) | 0;
    const noonUtc = ((12 + offset / 60 + 24) % 24) | 0;
    expect(formatLocalHour(midnightUtc, ref)).toBe(
      expectedLocalHour(midnightUtc),
    );
    expect(formatLocalHour(noonUtc, ref)).toBe(expectedLocalHour(noonUtc));
  });
});

describe("printAccountTable", () => {
  const stateDir = join(
    tmpdir(),
    `cc-ping-status-${process.pid}`,
    ".config",
    "cc-ping",
  );

  beforeEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    vi.mocked(listAccounts).mockReturnValue([]);
    vi.mocked(findDuplicates).mockReturnValue(new Map());
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("prints 'No accounts configured' when no accounts exist", () => {
    const lines: string[] = [];
    printAccountTable((msg: string) => lines.push(msg));
    expect(lines).toEqual(["No accounts configured"]);
  });

  it("prints status lines for configured accounts", () => {
    vi.mocked(listAccounts).mockReturnValue([
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "bob", configDir: "/tmp/bob" },
    ]);
    recordPing("alice", new Date("2025-01-01T00:00:00.000Z"));

    const lines: string[] = [];
    printAccountTable((msg: string) => lines.push(msg));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("alice");
    expect(lines[1]).toContain("bob");
    expect(lines[1]).toContain("unknown");
  });

  it("uses console.log by default", () => {
    vi.mocked(listAccounts).mockReturnValue([
      { handle: "alice", configDir: "/tmp/alice" },
    ]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printAccountTable();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("alice"));
    spy.mockRestore();
  });

  it("forwards now parameter to getAccountStatuses", () => {
    vi.mocked(listAccounts).mockReturnValue([
      { handle: "alice", configDir: "/tmp/alice" },
    ]);
    recordPing("alice", new Date("2025-01-01T00:00:00.000Z"));

    const lines: string[] = [];
    const now = new Date("2025-01-01T01:00:00.000Z");
    printAccountTable((msg: string) => lines.push(msg), now);
    expect(lines[0]).toContain("active");
    expect(lines[0]).toContain("resets in 4h 0m");
  });

  it("passes deferredHandles to getAccountStatuses", () => {
    vi.mocked(listAccounts).mockReturnValue([
      { handle: "alice", configDir: "/tmp/alice" },
    ]);
    recordPing("alice", new Date("2025-01-01T00:00:00.000Z"));

    const lines: string[] = [];
    const now = new Date("2025-01-01T06:00:00.000Z"); // window expired
    printAccountTable(
      (msg: string) => lines.push(msg),
      now,
      new Map([["alice", { optimalPingHour: 10, peakStart: 13, peakEnd: 18 }]]),
    );
    expect(lines[0]).toContain("deferred");
  });

  it("forwards daemonNextPingIn to formatStatusLine for needs-ping accounts", () => {
    vi.mocked(listAccounts).mockReturnValue([
      { handle: "alice", configDir: "/tmp/alice" },
    ]);
    recordPing("alice", new Date("2025-01-01T00:00:00.000Z"));

    const lines: string[] = [];
    const now = new Date("2025-01-01T06:00:00.000Z");
    printAccountTable((msg: string) => lines.push(msg), now, undefined, {
      daemonNextPingIn: "1h 23m",
    });
    expect(lines[0]).toContain("next ping in 1h 23m");
  });

  it("passes duplicates to getAccountStatuses", () => {
    const dupes = new Map([
      [
        "uuid-same",
        { handles: ["bernting", "bernting.se"], email: "w@bernting.se" },
      ],
    ]);
    vi.mocked(listAccounts).mockReturnValue([
      { handle: "bernting", configDir: "/tmp/bernting" },
      { handle: "bernting.se", configDir: "/tmp/bernting.se" },
    ]);
    vi.mocked(findDuplicates).mockReturnValue(dupes);

    const lines: string[] = [];
    printAccountTable((msg: string) => lines.push(msg));
    expect(lines[0]).toContain("[duplicate of bernting.se]");
    expect(lines[1]).toContain("[duplicate of bernting]");
  });
});
