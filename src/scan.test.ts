import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testHome = join(tmpdir(), `cc-ping-scan-${process.pid}`);
const accountsDir = join(testHome, ".claude-accounts");

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => join(tmpdir(), `cc-ping-scan-${process.pid}`),
  };
});

const { scanAccounts } = await import("./scan.js");

describe("scanAccounts", () => {
  beforeEach(() => {
    rmSync(accountsDir, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(accountsDir, { recursive: true, force: true });
  });

  it("returns empty array when directory does not exist", () => {
    expect(scanAccounts()).toEqual([]);
  });

  it("discovers account directories", () => {
    mkdirSync(join(accountsDir, "alice"), { recursive: true });
    mkdirSync(join(accountsDir, "bob"), { recursive: true });
    const accounts = scanAccounts();
    expect(accounts).toHaveLength(2);
    const handles = accounts.map((a) => a.handle).sort();
    expect(handles).toEqual(["alice", "bob"]);
  });

  it("ignores hidden directories", () => {
    mkdirSync(join(accountsDir, ".hidden"), { recursive: true });
    mkdirSync(join(accountsDir, "visible"), { recursive: true });
    const accounts = scanAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].handle).toBe("visible");
  });
});
