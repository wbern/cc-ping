import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("cc-ping CLI with fake claude", () => {
  let root: string;
  let configDir: string;
  let fakeBin: string;
  let accountDir: string;
  let fakeLog: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cc-ping-cli-fake-"));
    configDir = join(root, "config");
    fakeBin = join(root, "bin");
    accountDir = join(root, "account");
    fakeLog = join(root, "fake-claude.json");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(accountDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      `${JSON.stringify({
        accounts: [{ handle: "alice", configDir: accountDir }],
        settings: { pingMode: "print", model: "haiku", promptStyle: "math" },
      })}\n`,
    );
    writeFileSync(
      join(fakeBin, "claude"),
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.CC_PING_FAKE_LOG, JSON.stringify({",
        "  argv: process.argv.slice(2),",
        "  configDir: process.env.CLAUDE_CONFIG_DIR,",
        "}));",
        "console.log(JSON.stringify({",
        "  type: 'result',",
        "  subtype: 'success',",
        "  session_id: 'fake-session',",
        "  duration_ms: 10,",
        "  duration_api_ms: 5,",
        "  is_error: false,",
        "  num_turns: 1,",
        "  result: 'ok',",
        "  total_cost_usd: 0,",
        "  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },",
        "  model_usage: { haiku: {} }",
        "}));",
      ].join("\n"),
    );
    chmodSync(join(fakeBin, "claude"), 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("runs print mode through the packaged CLI without real Claude", () => {
    const output = execFileSync(
      process.execPath,
      [
        resolve("dist/cli.js"),
        "--config",
        configDir,
        "ping",
        "alice",
        "--json",
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          CC_PING_FAKE_LOG: fakeLog,
        },
      },
    );

    const result = JSON.parse(output);
    expect(result).toEqual([
      expect.objectContaining({
        handle: "alice",
        success: true,
        durationMs: expect.any(Number),
      }),
    ]);
    const fakeCall = JSON.parse(readFileSync(fakeLog, "utf-8"));
    expect(fakeCall.configDir).toBe(accountDir);
    expect(fakeCall.argv).toEqual(
      expect.arrayContaining([
        "-p",
        "--model",
        "haiku",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--tools",
        "",
        "--max-turns",
        "1",
      ]),
    );
  });
});
