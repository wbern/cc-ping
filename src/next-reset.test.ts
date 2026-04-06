import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => join(tmpdir(), `cc-ping-nextreset-${process.pid}`),
  };
});

const { recordPing } = await import("./state.js");
const { getNextReset } = await import("./next-reset.js");

describe("getNextReset", () => {
  const configDir = join(
    tmpdir(),
    `cc-ping-nextreset-${process.pid}`,
    ".config",
    "cc-ping",
  );

  beforeEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("returns null when no accounts have active windows", () => {
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];
    const result = getNextReset(accounts);
    expect(result).toBeNull();
  });

  it("returns the account with the soonest reset", () => {
    recordPing("alice", new Date("2025-01-01T00:00:00.000Z"));
    recordPing("bob", new Date("2025-01-01T02:00:00.000Z"));
    const now = new Date("2025-01-01T03:00:00.000Z");
    const accounts = [
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "bob", configDir: "/tmp/bob" },
    ];

    const result = getNextReset(accounts, now);
    expect(result).not.toBeNull();
    expect(result!.handle).toBe("alice");
    expect(result!.timeUntilReset).toBe("2h 0m");
  });

  it("skips accounts with expired windows", () => {
    recordPing("expired", new Date("2025-01-01T00:00:00.000Z"));
    recordPing("active", new Date("2025-01-01T04:00:00.000Z"));
    const now = new Date("2025-01-01T06:00:00.000Z"); // expired is 6h ago, active is 2h ago
    const accounts = [
      { handle: "expired", configDir: "/tmp/expired" },
      { handle: "active", configDir: "/tmp/active" },
    ];

    const result = getNextReset(accounts, now);
    expect(result).not.toBeNull();
    expect(result!.handle).toBe("active");
  });

  it("returns null when all windows are expired", () => {
    recordPing("old", new Date("2025-01-01T00:00:00.000Z"));
    const now = new Date("2025-01-01T10:00:00.000Z");
    const accounts = [{ handle: "old", configDir: "/tmp/old" }];

    const result = getNextReset(accounts, now);
    expect(result).toBeNull();
  });

  it("includes configDir and resetAt in result", () => {
    recordPing("alice", new Date("2025-01-01T00:00:00.000Z"));
    const now = new Date("2025-01-01T01:00:00.000Z");
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];

    const result = getNextReset(accounts, now);
    expect(result!.configDir).toBe("/tmp/alice");
    expect(result!.resetAt).toBe("2025-01-01T05:00:00.000Z");
  });
});
