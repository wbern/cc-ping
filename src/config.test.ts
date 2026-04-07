import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => join(tmpdir(), `cc-ping-home-${process.pid}`),
  };
});

// Dynamic import after mocks
const { loadConfig, saveConfig, addAccount, removeAccount, listAccounts } =
  await import("./config.js");

describe("config", () => {
  beforeEach(() => {
    // Ensure clean state by removing the mock homedir config
    const homeDir = join(tmpdir(), `cc-ping-home-${process.pid}`);
    const configDir = join(homeDir, ".config", "cc-ping");
    rmSync(configDir, { recursive: true, force: true });
  });

  afterEach(() => {
    const homeDir = join(tmpdir(), `cc-ping-home-${process.pid}`);
    const configDir = join(homeDir, ".config", "cc-ping");
    rmSync(configDir, { recursive: true, force: true });
  });

  it("returns empty config when no file exists", () => {
    const config = loadConfig();
    expect(config).toEqual({ accounts: [] });
  });

  it("returns empty config for corrupt file", () => {
    const homeDir = join(tmpdir(), `cc-ping-home-${process.pid}`);
    const configDir = join(homeDir, ".config", "cc-ping");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), "not json{{{");
    expect(loadConfig()).toEqual({ accounts: [] });
  });

  it("saves and loads config", () => {
    const config = { accounts: [{ handle: "test", configDir: "/tmp/test" }] };
    saveConfig(config);
    const loaded = loadConfig();
    expect(loaded).toEqual(config);
  });

  it("adds a new account", () => {
    addAccount("acct1", "/path/to/acct1");
    const accounts = listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toEqual({
      handle: "acct1",
      configDir: "/path/to/acct1",
    });
  });

  it("updates existing account", () => {
    addAccount("acct1", "/old/path");
    addAccount("acct1", "/new/path");
    const accounts = listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].configDir).toBe("/new/path");
  });

  it("removes an account", () => {
    addAccount("acct1", "/path1");
    addAccount("acct2", "/path2");
    const removed = removeAccount("acct1");
    expect(removed).toBe(true);
    expect(listAccounts()).toHaveLength(1);
    expect(listAccounts()[0].handle).toBe("acct2");
  });

  it("returns false when removing non-existent account", () => {
    const removed = removeAccount("nope");
    expect(removed).toBe(false);
  });

  it("adds an account with a group", () => {
    addAccount("acct1", "/path/to/acct1", "work");
    const accounts = listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].group).toBe("work");
  });

  it("updates group when re-adding existing account", () => {
    addAccount("acct1", "/path", "work");
    addAccount("acct1", "/path", "personal");
    const accounts = listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].group).toBe("personal");
  });
});
