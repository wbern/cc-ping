import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginAccount, resolveLoginTargets, runLogins } from "./login.js";
import type { AccountConfig } from "./types.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const mockSpawn = vi.mocked(spawn);

const base = join(tmpdir(), `cc-ping-login-${process.pid}`);

function makeAuthedDir(name: string, email = `${name}@example.com`): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({
      oauthAccount: { accountUuid: `uuid-${name}`, emailAddress: email },
    }),
  );
  return dir;
}

function makeUnauthedDir(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ foo: "bar" }));
  return dir;
}

beforeEach(() => {
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("resolveLoginTargets", () => {
  it("returns just the named account when a handle is given", () => {
    const accounts = [
      { handle: "alice", configDir: makeAuthedDir("alice") },
      { handle: "bob", configDir: makeAuthedDir("bob") },
    ];
    const targets = resolveLoginTargets(accounts, "bob", []);
    expect(targets.map((t) => t.handle)).toEqual(["bob"]);
  });

  it("propagates filterAccounts error for an unknown handle", () => {
    const accounts = [{ handle: "alice", configDir: makeAuthedDir("alice") }];
    expect(() => resolveLoginTargets(accounts, "nope", [])).toThrow(
      "Unknown account(s): nope",
    );
  });

  it("returns all flagged accounts in config order when no handle is given", () => {
    const accounts = [
      { handle: "alice", configDir: makeAuthedDir("alice") },
      { handle: "bob", configDir: makeUnauthedDir("bob") },
      { handle: "carol", configDir: makeAuthedDir("carol") },
    ];
    const targets = resolveLoginTargets(accounts, undefined, ["carol", "bob"]);
    expect(targets.map((t) => t.handle)).toEqual(["bob", "carol"]);
  });

  it("ignores flagged handles that are no longer configured", () => {
    const accounts = [{ handle: "alice", configDir: makeAuthedDir("alice") }];
    const targets = resolveLoginTargets(accounts, undefined, [
      "alice",
      "ghost",
    ]);
    expect(targets.map((t) => t.handle)).toEqual(["alice"]);
  });

  it("throws when nothing is flagged as needing login", () => {
    const accounts = [
      { handle: "alice", configDir: makeAuthedDir("alice") },
      { handle: "bob", configDir: makeAuthedDir("bob") },
    ];
    expect(() => resolveLoginTargets(accounts, undefined, [])).toThrow(
      "No accounts flagged as needing login. Specify one: cc-ping login <handle>",
    );
  });
});

describe("loginAccount", () => {
  function fakeSpawn() {
    const child = new EventEmitter() as ChildProcess;
    const spawn = vi.fn(
      (
        _command: string,
        _args: string[],
        _options: { stdio: "inherit"; cwd: string; env: NodeJS.ProcessEnv },
      ) => child,
    );
    return { child, spawn };
  }

  it("spawns claude auth login scoped to the config dir and prefills --email", async () => {
    const configDir = makeAuthedDir("alice", "alice@corp.com");
    const { child, spawn } = fakeSpawn();

    const promise = loginAccount({ handle: "alice", configDir }, { spawn });
    child.emit("close", 0);
    const result = await promise;

    expect(result).toEqual({ handle: "alice", configDir, exitCode: 0 });
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe("claude");
    expect(args).toEqual(["auth", "login", "--email", "alice@corp.com"]);
    expect(options.stdio).toBe("inherit");
    expect(options.cwd).toBe(tmpdir());
    expect(options.env.CLAUDE_CONFIG_DIR).toBe(configDir);
  });

  it("omits --email when the account has no stored identity", async () => {
    const configDir = makeUnauthedDir("bob");
    const { child, spawn } = fakeSpawn();

    const promise = loginAccount({ handle: "bob", configDir }, { spawn });
    child.emit("close", 0);
    await promise;

    const [, args] = spawn.mock.calls[0];
    expect(args).toEqual(["auth", "login"]);
  });

  it("propagates a non-zero exit code", async () => {
    const configDir = makeUnauthedDir("bob");
    const { child, spawn } = fakeSpawn();

    const promise = loginAccount({ handle: "bob", configDir }, { spawn });
    child.emit("close", 7);
    expect((await promise).exitCode).toBe(7);
  });

  it("treats a null exit code as success", async () => {
    const configDir = makeUnauthedDir("bob");
    const { child, spawn } = fakeSpawn();

    const promise = loginAccount({ handle: "bob", configDir }, { spawn });
    child.emit("close", null);
    expect((await promise).exitCode).toBe(0);
  });

  it("rejects when the child process errors", async () => {
    const configDir = makeUnauthedDir("bob");
    const { child, spawn } = fakeSpawn();

    const promise = loginAccount({ handle: "bob", configDir }, { spawn });
    child.emit("error", new Error("spawn ENOENT"));
    await expect(promise).rejects.toThrow("spawn ENOENT");
  });

  it("falls back to node's spawn when no deps are injected", async () => {
    const configDir = makeUnauthedDir("bob");
    const child = new EventEmitter() as ChildProcess;
    mockSpawn.mockReturnValue(child);

    const promise = loginAccount({ handle: "bob", configDir });
    child.emit("close", 0);

    expect((await promise).exitCode).toBe(0);
    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      ["auth", "login"],
      expect.objectContaining({ cwd: tmpdir() }),
    );
  });
});

describe("runLogins", () => {
  function makeTargets(...handles: string[]): AccountConfig[] {
    return handles.map((handle) => ({ handle, configDir: `/cfg/${handle}` }));
  }

  it("logs in each target sequentially in order", async () => {
    const targets = makeTargets("alice", "bob", "carol");
    const order: string[] = [];
    const loginAccount = vi.fn(async (account: AccountConfig) => {
      order.push(account.handle);
      return {
        handle: account.handle,
        configDir: account.configDir,
        exitCode: 0,
      };
    });

    const failed = await runLogins(targets, {
      loginAccount,
      clearAuthFailure: vi.fn(),
      log: vi.fn(),
      error: vi.fn(),
    });

    expect(order).toEqual(["alice", "bob", "carol"]);
    expect(failed).toBe(0);
  });

  it("prints the batch count message when more than one account needs login", async () => {
    const targets = makeTargets("alice", "bob");
    const log = vi.fn();
    const loginAccount = vi.fn(async (account: AccountConfig) => ({
      handle: account.handle,
      configDir: account.configDir,
      exitCode: 0,
    }));

    await runLogins(targets, {
      loginAccount,
      clearAuthFailure: vi.fn(),
      log,
      error: vi.fn(),
    });

    expect(log).toHaveBeenCalledWith("2 account(s) need login: alice, bob");
    expect(log).toHaveBeenCalledWith("[1/2] Logging in: alice -> /cfg/alice");
    expect(log).toHaveBeenCalledWith("[2/2] Logging in: bob -> /cfg/bob");
  });

  it("omits the batch message and step prefix for a single target", async () => {
    const targets = makeTargets("alice");
    const log = vi.fn();
    const loginAccount = vi.fn(async (account: AccountConfig) => ({
      handle: account.handle,
      configDir: account.configDir,
      exitCode: 0,
    }));

    await runLogins(targets, {
      loginAccount,
      clearAuthFailure: vi.fn(),
      log,
      error: vi.fn(),
    });

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("Logging in: alice -> /cfg/alice");
  });

  it("clears the auth failure only for accounts that exit 0", async () => {
    const targets = makeTargets("alice", "bob");
    const clearAuthFailure = vi.fn();
    const loginAccount = vi.fn(async (account: AccountConfig) => ({
      handle: account.handle,
      configDir: account.configDir,
      exitCode: account.handle === "alice" ? 0 : 3,
    }));

    const failed = await runLogins(targets, {
      loginAccount,
      clearAuthFailure,
      log: vi.fn(),
      error: vi.fn(),
    });

    expect(clearAuthFailure).toHaveBeenCalledTimes(1);
    expect(clearAuthFailure).toHaveBeenCalledWith("alice");
    expect(failed).toBe(1);
  });

  it("catches a spawn error, reports it, and counts it as a failure", async () => {
    const targets = makeTargets("alice", "bob");
    const error = vi.fn();
    const clearAuthFailure = vi.fn();
    const loginAccount = vi.fn(async (account: AccountConfig) => {
      if (account.handle === "alice") throw new Error("spawn ENOENT");
      return {
        handle: account.handle,
        configDir: account.configDir,
        exitCode: 0,
      };
    });

    const failed = await runLogins(targets, {
      loginAccount,
      clearAuthFailure,
      log: vi.fn(),
      error,
    });

    expect(error).toHaveBeenCalledWith("  alice: spawn ENOENT");
    expect(clearAuthFailure).toHaveBeenCalledWith("bob");
    expect(failed).toBe(1);
  });

  it("falls back to console sinks and the real loginAccount when no deps are injected", async () => {
    const child = new EventEmitter() as ChildProcess;
    mockSpawn.mockReturnValue(child);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Drive the spawn-error path so the default console sinks and the real
    // loginAccount are exercised without invoking the real clearAuthFailure
    // (which would write to state.json).
    const configDir = makeAuthedDir("alice", "alice@corp.com");
    const promise = runLogins([{ handle: "alice", configDir }]);
    child.emit("error", new Error("spawn ENOENT"));
    const failed = await promise;

    expect(failed).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(`Logging in: alice -> ${configDir}`);
    expect(errorSpy).toHaveBeenCalledWith("  alice: spawn ENOENT");
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
