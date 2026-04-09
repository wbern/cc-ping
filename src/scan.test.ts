import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testHome = join(tmpdir(), `cc-ping-scan-${process.pid}`);

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
    rmSync(testHome, { recursive: true, force: true });
    mkdirSync(testHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it("returns empty array when directory does not exist", () => {
    expect(scanAccounts("/tmp/cc-ping-nonexistent-dir")).toEqual([]);
  });

  it("returns empty array when no subdirectories have .claude.json", () => {
    mkdirSync(join(testHome, "empty-dir"), { recursive: true });
    expect(scanAccounts()).toEqual([]);
  });

  it("discovers account directories containing .claude.json", () => {
    mkdirSync(join(testHome, "alice"), { recursive: true });
    writeFileSync(join(testHome, "alice", ".claude.json"), "{}");
    mkdirSync(join(testHome, "bob"), { recursive: true });
    writeFileSync(join(testHome, "bob", ".claude.json"), "{}");
    const accounts = scanAccounts();
    expect(accounts).toHaveLength(2);
    const handles = accounts.map((a) => a.handle).sort();
    expect(handles).toEqual(["alice", "bob"]);
  });

  it("ignores hidden directories", () => {
    mkdirSync(join(testHome, ".hidden"), { recursive: true });
    writeFileSync(join(testHome, ".hidden", ".claude.json"), "{}");
    mkdirSync(join(testHome, "visible"), { recursive: true });
    writeFileSync(join(testHome, "visible", ".claude.json"), "{}");
    const accounts = scanAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].handle).toBe("visible");
  });

  it("only discovers directories containing .claude.json", () => {
    const customDir = join(testHome, "home-scan");
    mkdirSync(join(customDir, "real-account"), { recursive: true });
    writeFileSync(join(customDir, "real-account", ".claude.json"), "{}");
    mkdirSync(join(customDir, "random-folder"), { recursive: true });
    const accounts = scanAccounts(customDir);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].handle).toBe("real-account");
    rmSync(customDir, { recursive: true, force: true });
  });

  it("scans a custom directory when provided", () => {
    const customDir = join(testHome, "custom-accounts");
    mkdirSync(join(customDir, "carol"), { recursive: true });
    writeFileSync(join(customDir, "carol", ".claude.json"), "{}");
    mkdirSync(join(customDir, "dave"), { recursive: true });
    writeFileSync(join(customDir, "dave", ".claude.json"), "{}");
    const accounts = scanAccounts(customDir);
    const handles = accounts.map((a) => a.handle).sort();
    expect(handles).toEqual(["carol", "dave"]);
    expect(accounts[0].configDir).toBe(join(customDir, accounts[0].handle));
    rmSync(customDir, { recursive: true, force: true });
  });
});
