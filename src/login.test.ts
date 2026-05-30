import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginAccount, resolveLoginTargets } from "./login.js";

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
