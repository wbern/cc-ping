import { describe, expect, it } from "vitest";
import { filterAccounts } from "./filter-accounts.js";
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
