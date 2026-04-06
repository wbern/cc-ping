import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkAccount, checkAccounts } from "./check.js";

describe("checkAccount", () => {
  const base = join(tmpdir(), `cc-ping-check-${process.pid}`);

  beforeEach(() => {
    rmSync(base, { recursive: true, force: true });
    mkdirSync(base, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("returns healthy when config dir has valid .claude.json with oauth", () => {
    const dir = join(base, "alice");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({
        oauthAccount: {
          accountUuid: "uuid-1",
          emailAddress: "alice@example.com",
        },
      }),
    );

    const result = checkAccount({ handle: "alice", configDir: dir });
    expect(result.handle).toBe("alice");
    expect(result.healthy).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("reports missing config directory", () => {
    const dir = join(base, "missing");

    const result = checkAccount({ handle: "missing", configDir: dir });
    expect(result.healthy).toBe(false);
    expect(result.issues).toContain("config directory does not exist");
  });

  it("reports missing .claude.json", () => {
    const dir = join(base, "nofile");
    mkdirSync(dir, { recursive: true });

    const result = checkAccount({ handle: "nofile", configDir: dir });
    expect(result.healthy).toBe(false);
    expect(result.issues).toContain(".claude.json not found");
  });

  it("reports invalid JSON in .claude.json", () => {
    const dir = join(base, "badjson");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".claude.json"), "not json");

    const result = checkAccount({ handle: "badjson", configDir: dir });
    expect(result.healthy).toBe(false);
    expect(result.issues).toContain(".claude.json is not valid JSON");
  });

  it("reports missing oauth credentials", () => {
    const dir = join(base, "nooauth");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ foo: "bar" }));

    const result = checkAccount({ handle: "nooauth", configDir: dir });
    expect(result.healthy).toBe(false);
    expect(result.issues).toContain("no OAuth credentials found");
  });
});

describe("checkAccounts", () => {
  const base = join(tmpdir(), `cc-ping-check-${process.pid}`);

  beforeEach(() => {
    rmSync(base, { recursive: true, force: true });
    mkdirSync(base, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("checks all accounts and returns results", () => {
    const healthy = join(base, "good");
    mkdirSync(healthy, { recursive: true });
    writeFileSync(
      join(healthy, ".claude.json"),
      JSON.stringify({
        oauthAccount: {
          accountUuid: "uuid-1",
          emailAddress: "good@example.com",
        },
      }),
    );

    const accounts = [
      { handle: "good", configDir: healthy },
      { handle: "bad", configDir: join(base, "nonexistent") },
    ];

    const results = checkAccounts(accounts);
    expect(results).toHaveLength(2);
    expect(results[0].healthy).toBe(true);
    expect(results[1].healthy).toBe(false);
  });
});
