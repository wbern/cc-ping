import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => join(tmpdir(), `cc-ping-suggest-${process.pid}`),
  };
});

const { recordPing } = await import("./state.js");
const { suggestAccount } = await import("./suggest.js");

describe("suggestAccount", () => {
  const configDir = join(
    tmpdir(),
    `cc-ping-suggest-${process.pid}`,
    ".config",
    "cc-ping",
  );

  beforeEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("returns null for empty accounts list", () => {
    const result = suggestAccount([]);
    expect(result).toBeNull();
  });

  it("returns first account when none have been pinged", () => {
    const accounts = [
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "bob", configDir: "/tmp/bob" },
    ];
    const result = suggestAccount(accounts);
    expect(result).not.toBeNull();
    expect(result!.handle).toBe("alice");
    expect(result!.reason).toBe("no active window");
  });

  it("prefers account with no active window over one with active window", () => {
    recordPing("alice", new Date("2025-01-01T04:00:00.000Z"));
    const now = new Date("2025-01-01T05:00:00.000Z");
    const accounts = [
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "bob", configDir: "/tmp/bob" },
    ];

    const result = suggestAccount(accounts, now);
    expect(result!.handle).toBe("bob");
    expect(result!.reason).toBe("no active window");
  });

  it("returns account with most remaining window time when all have active windows", () => {
    recordPing("alice", new Date("2025-01-01T00:00:00.000Z"));
    recordPing("bob", new Date("2025-01-01T02:00:00.000Z"));
    const now = new Date("2025-01-01T03:00:00.000Z");
    const accounts = [
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "bob", configDir: "/tmp/bob" },
    ];

    const result = suggestAccount(accounts, now);
    expect(result!.handle).toBe("bob");
    expect(result!.reason).toBe("most remaining window time");
  });

  it("returns account with expired window over one with active window", () => {
    recordPing("alice", new Date("2025-01-01T00:00:00.000Z")); // expired at +5h
    recordPing("bob", new Date("2025-01-01T04:00:00.000Z")); // active until 09:00
    const now = new Date("2025-01-01T06:00:00.000Z");
    const accounts = [
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "bob", configDir: "/tmp/bob" },
    ];

    const result = suggestAccount(accounts, now);
    expect(result!.handle).toBe("alice");
    expect(result!.reason).toBe("no active window");
  });

  it("includes configDir and timeUntilReset in result", () => {
    recordPing("alice", new Date("2025-01-01T02:00:00.000Z"));
    const now = new Date("2025-01-01T03:00:00.000Z");
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];

    const result = suggestAccount(accounts, now);
    expect(result!.configDir).toBe("/tmp/alice");
    expect(result!.timeUntilReset).toBe("4h 0m");
  });

  it("returns null timeUntilReset for account with no active window", () => {
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];
    const result = suggestAccount(accounts);
    expect(result!.timeUntilReset).toBeNull();
  });
});
