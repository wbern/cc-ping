import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDuplicates, readAccountIdentity } from "./identity.js";

describe("readAccountIdentity", () => {
  const testDir = join(tmpdir(), `cc-ping-identity-${process.pid}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("reads valid .claude.json and returns identity", () => {
    writeFileSync(
      join(testDir, ".claude.json"),
      JSON.stringify({
        oauthAccount: {
          accountUuid: "uuid-123",
          emailAddress: "alice@example.com",
        },
      }),
    );
    const identity = readAccountIdentity(testDir);
    expect(identity).toEqual({
      accountUuid: "uuid-123",
      email: "alice@example.com",
    });
  });

  it("returns null for missing file", () => {
    expect(readAccountIdentity(join(testDir, "nonexistent"))).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    writeFileSync(join(testDir, ".claude.json"), "not json {{{");
    expect(readAccountIdentity(testDir)).toBeNull();
  });

  it("returns null for missing oauthAccount", () => {
    writeFileSync(join(testDir, ".claude.json"), JSON.stringify({ foo: 1 }));
    expect(readAccountIdentity(testDir)).toBeNull();
  });

  it("returns null for missing accountUuid", () => {
    writeFileSync(
      join(testDir, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "alice@example.com" },
      }),
    );
    expect(readAccountIdentity(testDir)).toBeNull();
  });

  it("returns null for missing emailAddress", () => {
    writeFileSync(
      join(testDir, ".claude.json"),
      JSON.stringify({
        oauthAccount: { accountUuid: "uuid-123" },
      }),
    );
    expect(readAccountIdentity(testDir)).toBeNull();
  });
});

describe("findDuplicates", () => {
  const testDir = join(tmpdir(), `cc-ping-dup-${process.pid}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeAccount(handle: string, uuid: string, email: string) {
    const dir = join(testDir, handle);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({
        oauthAccount: { accountUuid: uuid, emailAddress: email },
      }),
    );
    return { handle, configDir: dir };
  }

  it("returns empty map when no duplicates", () => {
    const accounts = [
      makeAccount("alice", "uuid-1", "alice@example.com"),
      makeAccount("bob", "uuid-2", "bob@example.com"),
    ];
    const dupes = findDuplicates(accounts);
    expect(dupes.size).toBe(0);
  });

  it("groups handles sharing same accountUuid", () => {
    const accounts = [
      makeAccount("bernting", "uuid-same", "william@bernting.se"),
      makeAccount("bernting.se", "uuid-same", "william@bernting.se"),
      makeAccount("other", "uuid-other", "other@example.com"),
    ];
    const dupes = findDuplicates(accounts);
    expect(dupes.size).toBe(1);
    const group = dupes.get("uuid-same");
    expect(group).toEqual({
      handles: ["bernting", "bernting.se"],
      email: "william@bernting.se",
    });
  });

  it("skips accounts with unreadable identity", () => {
    const accounts = [
      makeAccount("valid", "uuid-1", "valid@example.com"),
      { handle: "broken", configDir: join(testDir, "nonexistent") },
    ];
    const dupes = findDuplicates(accounts);
    expect(dupes.size).toBe(0);
  });
});
