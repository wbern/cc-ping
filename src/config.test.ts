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
  getRemoteNotify,
  setRemoteNotifyUrl,
  clearRemoteNotify,
  getNotifyCommand,
  setNotifyCommand,
  clearNotifyCommand,
  resolveSettings,
  setSetting,
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

  it("returns undefined remote-notify config when unset", () => {
    expect(getRemoteNotify()).toBeUndefined();
  });

  it("sets and reads the remote-notify URL", () => {
    setRemoteNotifyUrl("https://ntfy.sh/secret");
    expect(getRemoteNotify()).toEqual({ url: "https://ntfy.sh/secret" });
  });

  it("preserves existing events when updating the URL", () => {
    saveConfig({
      accounts: [],
      remoteNotify: { url: "https://old", events: ["failure"] },
    });
    setRemoteNotifyUrl("https://ntfy.sh/new");
    expect(getRemoteNotify()).toEqual({
      url: "https://ntfy.sh/new",
      events: ["failure"],
    });
  });

  it("preserves accounts when setting the remote-notify URL", () => {
    addAccount("acct1", "/path1");
    setRemoteNotifyUrl("https://ntfy.sh/secret");
    expect(listAccounts()).toHaveLength(1);
    expect(getRemoteNotify()?.url).toBe("https://ntfy.sh/secret");
  });

  it("clears the remote-notify config", () => {
    setRemoteNotifyUrl("https://ntfy.sh/secret");
    expect(clearRemoteNotify()).toBe(true);
    expect(getRemoteNotify()).toBeUndefined();
  });

  it("returns false when clearing an unset remote-notify config", () => {
    expect(clearRemoteNotify()).toBe(false);
  });

  it("returns undefined notify command when unset", () => {
    expect(getNotifyCommand()).toBeUndefined();
  });

  it("sets and reads the notify command", () => {
    setNotifyCommand(["notify-send", "-u", "critical"]);
    expect(getNotifyCommand()).toEqual(["notify-send", "-u", "critical"]);
  });

  it("preserves accounts when setting the notify command", () => {
    addAccount("acct1", "/path1");
    setNotifyCommand(["alert"]);
    expect(listAccounts()).toHaveLength(1);
    expect(getNotifyCommand()).toEqual(["alert"]);
  });

  it("overwrites an existing notify command", () => {
    setNotifyCommand(["old"]);
    setNotifyCommand(["new", "arg"]);
    expect(getNotifyCommand()).toEqual(["new", "arg"]);
  });

  it("clears the notify command", () => {
    setNotifyCommand(["alert"]);
    expect(clearNotifyCommand()).toBe(true);
    expect(getNotifyCommand()).toBeUndefined();
  });

  it("returns false when clearing an unset notify command", () => {
    expect(clearNotifyCommand()).toBe(false);
  });

  it("resolves settings with safe defaults", () => {
    expect(resolveSettings()).toEqual({
      pingMode: "print",
      interactiveExitDelayMs: 2500,
      interactiveReadyPattern: "(\\u276f|>|›)[ \\u00a0]*",
      interactiveReadyFallbackDelayMs: 5000,
      promptStyle: "mixed",
      model: "haiku",
    });
  });

  it("normalizes setting aliases", () => {
    saveConfig({
      accounts: [],
      settings: { pingMode: "legacy-print", promptStyle: "chess" },
    });

    expect(resolveSettings().pingMode).toBe("print");
    expect(resolveSettings().promptStyle).toBe("chess");
    expect(
      resolveSettings({ accounts: [], settings: { pingMode: "interactive" } })
        .pingMode,
    ).toBe("experimental-interactive");
  });

  it("falls back from invalid persisted settings", () => {
    const settings = resolveSettings({
      accounts: [],
      settings: {
        interactiveExitDelayMs: Number.NaN,
        interactiveReadyPattern: " ",
        interactiveReadyFallbackDelayMs: -1,
        promptStyle: "wat" as never,
        model: "",
      },
    });

    expect(settings.interactiveExitDelayMs).toBe(2500);
    expect(settings.interactiveReadyPattern).toBe("(\\u276f|>|›)[ \\u00a0]*");
    expect(settings.interactiveReadyFallbackDelayMs).toBe(5000);
    expect(settings.promptStyle).toBe("mixed");
    expect(settings.model).toBe("haiku");
  });

  it("resolves valid custom interactive settings", () => {
    const settings = resolveSettings({
      accounts: [],
      settings: {
        interactiveExitDelayMs: 750,
        interactiveReadyPattern: "READY>",
        interactiveReadyFallbackDelayMs: 1250,
      },
    });

    expect(settings.interactiveExitDelayMs).toBe(750);
    expect(settings.interactiveReadyPattern).toBe("READY>");
    expect(settings.interactiveReadyFallbackDelayMs).toBe(1250);
  });

  it("sets validated settings while preserving other config", () => {
    saveConfig({
      accounts: [{ handle: "acct1", configDir: "/path" }],
      remoteNotify: { url: "https://ntfy.sh/topic" },
    });

    const settings = setSetting("pingMode", "experimental-interactive");
    setSetting("model", "sonnet");
    setSetting("promptStyle", "chess");

    expect(settings.pingMode).toBe("experimental-interactive");
    expect(loadConfig()).toEqual({
      accounts: [{ handle: "acct1", configDir: "/path" }],
      remoteNotify: { url: "https://ntfy.sh/topic" },
      settings: expect.objectContaining({
        pingMode: "experimental-interactive",
        model: "sonnet",
        promptStyle: "chess",
      }),
    });
  });

  it("sets compatibility aliases and interactive numeric settings", () => {
    expect(setSetting("pingMode", "legacy-print").pingMode).toBe("print");
    expect(setSetting("pingMode", "interactive").pingMode).toBe(
      "experimental-interactive",
    );
    expect(
      setSetting("interactiveExitDelayMs", "750").interactiveExitDelayMs,
    ).toBe(750);
    expect(
      setSetting("interactiveReadyFallbackDelayMs", "1250")
        .interactiveReadyFallbackDelayMs,
    ).toBe(1250);
    expect(
      setSetting("interactiveReadyPattern", "READY>").interactiveReadyPattern,
    ).toBe("READY>");
  });

  it("rejects unsupported setting keys and invalid values", () => {
    expect(() => setSetting("nope", "x")).toThrow("Unsupported setting: nope");
    expect(() => setSetting("pingMode", "x")).toThrow(
      "pingMode must be 'print' or 'experimental-interactive'",
    );
    expect(() => setSetting("interactiveExitDelayMs", "-1")).toThrow(
      "interactiveExitDelayMs must be a non-negative number",
    );
    expect(() => setSetting("interactiveReadyPattern", "")).toThrow(
      "interactiveReadyPattern must not be empty",
    );
    expect(() => setSetting("promptStyle", "x")).toThrow(
      "promptStyle must be 'mixed', 'math', 'trivia', 'tiny-chat', or 'chess'",
    );
    expect(() => setSetting("model", "")).toThrow("model must not be empty");
  });
});
