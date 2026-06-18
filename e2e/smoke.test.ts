/**
 * E2E smoke tests — run manually against real accounts on this machine.
 *
 *   pnpm test:e2e          # fake CLI only, no real Claude account required
 *   E2E_SCAN=1 pnpm test:e2e # scan local account directories
 *   pnpm test:e2e:ping     # scan + real ping (uses quota)
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { pingAccounts } from "../src/ping.js";
import type { PingResult } from "../src/types.js";
import { scanAccounts } from "../src/scan.js";

const accountsDir = join(homedir(), ".claude-accounts");

describe.skipIf(!process.env.E2E_SCAN && !process.env.E2E_PING)(
  "account discovery",
  () => {
    it("~/.claude-accounts/ directory exists", () => {
      expect(
        existsSync(accountsDir),
        `Expected ${accountsDir} to exist`,
      ).toBe(true);
    });

    it("discovers at least one account", () => {
      const accounts = scanAccounts();
      expect(accounts.length).toBeGreaterThan(0);
      console.log(`Found ${accounts.length} account(s).`);
    });

    it("each discovered account has a valid configDir", () => {
      const accounts = scanAccounts();
      for (const account of accounts) {
        expect(account.handle).toBeTruthy();
        expect(
          existsSync(account.configDir),
          `configDir missing for ${account.handle}: ${account.configDir}`,
        ).toBe(true);
      }
    });
  },
);

describe.skipIf(!process.env.E2E_PING)("ping", () => {
  let result: PingResult;

  beforeAll(async () => {
    const accounts = scanAccounts();
    expect(accounts.length).toBeGreaterThan(0);

    const [first] = accounts;
    console.log(`Pinging ${first.handle}...`);
    const results = await pingAccounts([first]);

    expect(results).toHaveLength(1);
    result = results[0];
    console.log(
      `Pinged ${first.handle}: ${result.success ? "ok" : "FAIL"} ${result.durationMs}ms`,
    );
  }, 60_000);

  it("successfully pings the first discovered account", () => {
    expect(result.success).toBe(true);
  });

  it("returns claudeResponse metadata in default print mode", () => {
    expect(result.claudeResponse).toBeDefined();
  });
});

describe.skipIf(!process.env.E2E_PING_PRINT)("print ping", () => {
  let result: PingResult;

  beforeAll(async () => {
    const accounts = scanAccounts();
    expect(accounts.length).toBeGreaterThan(0);

    const [first] = accounts;
    console.log(`Pinging ${first.handle} in print mode...`);
    const results = await pingAccounts([first], { mode: "print" });

    expect(results).toHaveLength(1);
    result = results[0];
  }, 60_000);

  it("returns claudeResponse with valid metadata", () => {
    expect(result.claudeResponse).toBeDefined();
    expect(result.claudeResponse!.session_id).toBeTruthy();
    expect(result.claudeResponse!.total_cost_usd).toBeGreaterThanOrEqual(0);
    expect(result.claudeResponse!.usage.input_tokens).toBeGreaterThan(0);
    console.log(
      `  session: ${result.claudeResponse!.session_id}`,
      `cost: $${result.claudeResponse!.total_cost_usd.toFixed(4)}`,
      `tokens: ${result.claudeResponse!.usage.input_tokens + result.claudeResponse!.usage.output_tokens}`,
      `model: ${result.claudeResponse!.model}`,
    );
  });
});
