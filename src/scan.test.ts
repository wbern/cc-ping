import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

const {
  buildScanCandidates,
  mergeScannedAccounts,
  parseScanSelection,
  scanAccounts,
} = await import("./scan.js");

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

  it("skips macOS TCC-protected and cloud-sync folders by name", () => {
    // These would trigger system permission prompts if walked. Even with a
    // .claude.json inside, they must be skipped before any statSync/existsSync.
    for (const name of [
      "Documents",
      "Pictures",
      "Google Drive",
      "Library",
      "Dropbox",
    ]) {
      mkdirSync(join(testHome, name), { recursive: true });
      writeFileSync(join(testHome, name, ".claude.json"), "{}");
    }
    mkdirSync(join(testHome, "real-account"), { recursive: true });
    writeFileSync(join(testHome, "real-account", ".claude.json"), "{}");
    const accounts = scanAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].handle).toBe("real-account");
  });

  it("matches skip-list folders case-insensitively", () => {
    mkdirSync(join(testHome, "DOWNLOADS"), { recursive: true });
    writeFileSync(join(testHome, "DOWNLOADS", ".claude.json"), "{}");
    expect(scanAccounts()).toEqual([]);
  });

  it("does not apply the skip list to an explicitly provided directory", () => {
    // A user pointing scan at a specific dir means it verbatim — a folder that
    // happens to be named like a system folder must still be discovered.
    const customDir = join(testHome, "explicit");
    mkdirSync(join(customDir, "documents"), { recursive: true });
    writeFileSync(join(customDir, "documents", ".claude.json"), "{}");
    const accounts = scanAccounts(customDir);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].handle).toBe("documents");
  });

  it("skips entries whose stat throws (dangling symlinks, etc.)", () => {
    symlinkSync(
      join(testHome, "does-not-exist"),
      join(testHome, "broken-link"),
    );
    mkdirSync(join(testHome, "real-account"), { recursive: true });
    writeFileSync(join(testHome, "real-account", ".claude.json"), "{}");
    const accounts = scanAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].handle).toBe("real-account");
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

  it("marks existing accounts selected and new accounts unselected", () => {
    const candidates = buildScanCandidates(
      [{ handle: "alice", configDir: "/tmp/alice", group: "work" }],
      [
        { handle: "alice", configDir: "/tmp/alice" },
        { handle: "bob", configDir: "/tmp/bob" },
      ],
    );

    expect(candidates).toEqual([
      {
        account: { handle: "alice", configDir: "/tmp/alice", group: "work" },
        status: "existing",
        selected: true,
      },
      {
        account: { handle: "bob", configDir: "/tmp/bob" },
        status: "new",
        selected: false,
      },
    ]);
  });

  it("keeps configured accounts selected even when missing from scan", () => {
    const candidates = buildScanCandidates(
      [{ handle: "alice", configDir: "/tmp/alice" }],
      [],
    );

    expect(candidates).toEqual([
      {
        account: { handle: "alice", configDir: "/tmp/alice" },
        status: "missing",
        selected: true,
      },
    ]);
  });

  it("parses default, all, none, list, and range selections", () => {
    const candidates = buildScanCandidates(
      [{ handle: "alice", configDir: "/tmp/alice" }],
      [
        { handle: "bob", configDir: "/tmp/bob" },
        { handle: "charlie", configDir: "/tmp/charlie" },
      ],
    );

    expect(parseScanSelection("", candidates)).toEqual([0]);
    expect(parseScanSelection("all", candidates)).toEqual([0, 1, 2]);
    expect(parseScanSelection("none", candidates)).toEqual([]);
    expect(parseScanSelection("2", candidates)).toEqual([1]);
    expect(parseScanSelection("1,3", candidates)).toEqual([0, 2]);
    expect(parseScanSelection("1,,2", candidates)).toEqual([0, 1]);
    expect(parseScanSelection("1-2", candidates)).toEqual([0, 1]);
  });

  it("rejects invalid selection input", () => {
    const candidates = buildScanCandidates(
      [],
      [{ handle: "alice", configDir: "/tmp/alice" }],
    );

    expect(() => parseScanSelection("2", candidates)).toThrow(
      "Selection out of range: 2",
    );
    expect(() => parseScanSelection("2-1", candidates)).toThrow(
      "Invalid selection range: 2-1",
    );
    expect(() => parseScanSelection("wat", candidates)).toThrow(
      "Invalid selection: wat",
    );
  });

  it("merges selected scan accounts without dropping global config", () => {
    const config = {
      accounts: [{ handle: "alice", configDir: "/tmp/alice", group: "work" }],
      remoteNotify: { url: "https://ntfy.sh/topic" },
      settings: { promptStyle: "chess" as const },
    };
    const candidates = buildScanCandidates(config.accounts, [
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "bob", configDir: "/tmp/bob" },
    ]);

    const next = mergeScannedAccounts(config, candidates, [0, 1]);

    expect(next).toEqual({
      accounts: [
        { handle: "alice", configDir: "/tmp/alice", group: "work" },
        { handle: "bob", configDir: "/tmp/bob" },
      ],
      remoteNotify: { url: "https://ntfy.sh/topic" },
      settings: { promptStyle: "chess" },
    });
  });
});
