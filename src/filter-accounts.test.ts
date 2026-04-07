import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => join(tmpdir(), `cc-ping-filter-${process.pid}`),
  };
});

const { recordPing } = await import("./state.js");
const { filterAccounts, filterByGroup, filterNeedsPing } = await import(
  "./filter-accounts.js"
);

import type { AccountConfig } from "./types.js";

const accounts: AccountConfig[] = [
  { handle: "alice", configDir: "/tmp/alice" },
  { handle: "bob", configDir: "/tmp/bob" },
  { handle: "carol", configDir: "/tmp/carol" },
];

describe("filterAccounts", () => {
  it("returns all accounts when no handles specified", () => {
    const result = filterAccounts(accounts, []);
    expect(result).toEqual(accounts);
  });

  it("filters to a single account by handle", () => {
    const result = filterAccounts(accounts, ["bob"]);
    expect(result).toEqual([{ handle: "bob", configDir: "/tmp/bob" }]);
  });

  it("filters to multiple accounts by handle", () => {
    const result = filterAccounts(accounts, ["alice", "carol"]);
    expect(result).toEqual([
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "carol", configDir: "/tmp/carol" },
    ]);
  });

  it("preserves original order of accounts", () => {
    const result = filterAccounts(accounts, ["carol", "alice"]);
    expect(result).toEqual([
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "carol", configDir: "/tmp/carol" },
    ]);
  });

  it("throws when a handle is not found", () => {
    expect(() => filterAccounts(accounts, ["alice", "unknown"])).toThrow(
      "Unknown account(s): unknown",
    );
  });

  it("throws listing all unknown handles", () => {
    expect(() => filterAccounts(accounts, ["x", "y"])).toThrow(
      "Unknown account(s): x, y",
    );
  });
});

describe("filterByGroup", () => {
  const grouped: AccountConfig[] = [
    { handle: "alice", configDir: "/tmp/alice", group: "work" },
    { handle: "bob", configDir: "/tmp/bob", group: "personal" },
    { handle: "carol", configDir: "/tmp/carol", group: "work" },
    { handle: "dave", configDir: "/tmp/dave" },
  ];

  it("returns all accounts when no group specified", () => {
    const result = filterByGroup(grouped, undefined);
    expect(result).toEqual(grouped);
  });

  it("filters accounts by group", () => {
    const result = filterByGroup(grouped, "work");
    expect(result).toEqual([
      { handle: "alice", configDir: "/tmp/alice", group: "work" },
      { handle: "carol", configDir: "/tmp/carol", group: "work" },
    ]);
  });

  it("returns only matching group", () => {
    const result = filterByGroup(grouped, "personal");
    expect(result).toEqual([
      { handle: "bob", configDir: "/tmp/bob", group: "personal" },
    ]);
  });

  it("throws when no accounts match the group", () => {
    expect(() => filterByGroup(grouped, "unknown")).toThrow(
      "No accounts in group: unknown",
    );
  });
});

describe("filterNeedsPing", () => {
  const stateDir = join(
    tmpdir(),
    `cc-ping-filter-${process.pid}`,
    ".config",
    "cc-ping",
  );

  beforeEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns all accounts when none have been pinged", () => {
    const accts = [
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "bob", configDir: "/tmp/bob" },
    ];
    expect(filterNeedsPing(accts)).toEqual(accts);
  });

  it("excludes accounts with active windows", () => {
    const now = new Date("2025-01-01T01:00:00.000Z");
    recordPing("alice", new Date("2025-01-01T00:00:00.000Z"));
    const accts = [
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "bob", configDir: "/tmp/bob" },
    ];
    const result = filterNeedsPing(accts, now);
    expect(result).toEqual([{ handle: "bob", configDir: "/tmp/bob" }]);
  });

  it("includes accounts whose window has expired", () => {
    recordPing("alice", new Date("2025-01-01T00:00:00.000Z"));
    const now = new Date("2025-01-01T06:00:00.000Z"); // 6h later
    const accts = [{ handle: "alice", configDir: "/tmp/alice" }];
    expect(filterNeedsPing(accts, now)).toEqual(accts);
  });

  it("returns empty array when all accounts are active", () => {
    const now = new Date("2025-01-01T01:00:00.000Z");
    recordPing("alice", new Date("2025-01-01T00:00:00.000Z"));
    recordPing("bob", new Date("2025-01-01T00:00:00.000Z"));
    const accts = [
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "bob", configDir: "/tmp/bob" },
    ];
    expect(filterNeedsPing(accts, now)).toEqual([]);
  });
});
