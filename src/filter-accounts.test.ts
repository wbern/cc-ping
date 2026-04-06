import { describe, expect, it } from "vitest";
import { filterAccounts, filterByGroup } from "./filter-accounts.js";
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
