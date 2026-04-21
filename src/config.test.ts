import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const {
  loadConfig,
  saveConfig,
  addAccount,
  removeAccount,
  listAccounts,
  resetSchedule,
} = await import("./config.js");
const { recordPing, loadState } = await import("./state.js");

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

  it("clears state entries for the removed account", () => {
    addAccount("acct1", "/path1");
    addAccount("acct2", "/path2");
    recordPing("acct1", new Date("2025-03-15T10:00:00.000Z"), {
      costUsd: 0.003,
      inputTokens: 10,
      outputTokens: 5,
      model: "m",
      sessionId: "s",
    });
    recordPing("acct2", new Date("2025-03-15T11:00:00.000Z"));
    removeAccount("acct1");
    const state = loadState();
    expect(state.lastPing.acct1).toBeUndefined();
    expect(state.lastPingMeta?.acct1).toBeUndefined();
    expect(state.lastPing.acct2).toBe("2025-03-15T11:00:00.000Z");
  });

  it("leaves history.jsonl untouched when removing account", () => {
    const homeDir = join(tmpdir(), `cc-ping-home-${process.pid}`);
    const configDir = join(homeDir, ".config", "cc-ping");
    mkdirSync(configDir, { recursive: true });
    const historyPath = join(configDir, "history.jsonl");
    const historyLine = `${JSON.stringify({
      timestamp: "2025-03-15T10:00:00.000Z",
      handle: "acct1",
      success: true,
      durationMs: 1234,
    })}\n`;
    writeFileSync(historyPath, historyLine);
    addAccount("acct1", "/path1");
    removeAccount("acct1");
    expect(existsSync(historyPath)).toBe(true);
    expect(readFileSync(historyPath, "utf-8")).toBe(historyLine);
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

  it("sets scheduleResetAt for a specific account", () => {
    addAccount("acct1", "/path1");
    addAccount("acct2", "/path2");
    const now = new Date("2026-04-09T12:00:00.000Z");
    resetSchedule("acct1", now);
    const accounts = listAccounts();
    expect(accounts[0].scheduleResetAt).toBe("2026-04-09T12:00:00.000Z");
    expect(accounts[1].scheduleResetAt).toBeUndefined();
  });

  it("sets scheduleResetAt for all accounts when no handle given", () => {
    addAccount("acct1", "/path1");
    addAccount("acct2", "/path2");
    const now = new Date("2026-04-09T12:00:00.000Z");
    resetSchedule(undefined, now);
    const accounts = listAccounts();
    expect(accounts[0].scheduleResetAt).toBe("2026-04-09T12:00:00.000Z");
    expect(accounts[1].scheduleResetAt).toBe("2026-04-09T12:00:00.000Z");
  });

  it("returns false when resetting all with no accounts configured", () => {
    expect(resetSchedule()).toBe(false);
  });

  it("returns false when resetting non-existent account", () => {
    expect(resetSchedule("nope")).toBe(false);
  });
});
