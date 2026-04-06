import { Command } from "commander";
import {
  addAccount,
  listAccounts,
  removeAccount,
  saveConfig,
} from "./config.js";
import { findDuplicates } from "./identity.js";
import { pingAccounts } from "./ping.js";
import { scanAccounts } from "./scan.js";
import { formatTimeRemaining, getWindowReset, recordPing } from "./state.js";
import { formatStatusLine, getAccountStatuses } from "./status.js";
import type { PingMeta } from "./types.js";

declare const __VERSION__: string;

const program = new Command()
  .name("cc-ping")
  .description("Ping Claude Code sessions to trigger quota windows early")
  .version(__VERSION__);

program
  .command("ping")
  .description("Ping all configured accounts to start quota windows")
  .option("--parallel", "Ping all accounts in parallel", false)
  .action(async (opts) => {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      console.error(
        "No accounts configured. Run: cc-ping scan or cc-ping add <handle> <dir>",
      );
      process.exit(1);
    }
    console.log(`Pinging ${accounts.length} account(s)...`);
    const results = await pingAccounts(accounts, { parallel: opts.parallel });
    for (const r of results) {
      const status = r.success ? "ok" : "FAIL";
      const detail = r.error ? ` (${r.error})` : "";
      const cr = r.claudeResponse;
      const costInfo = cr
        ? `  $${cr.total_cost_usd.toFixed(4)} ${cr.usage.input_tokens + cr.usage.output_tokens} tok`
        : "";
      console.log(
        `  ${r.handle}: ${status} ${r.durationMs}ms${detail}${costInfo}`,
      );
      if (r.success) {
        let meta: PingMeta | undefined;
        if (cr) {
          meta = {
            costUsd: cr.total_cost_usd,
            inputTokens: cr.usage.input_tokens,
            outputTokens: cr.usage.output_tokens,
            model: cr.model,
            sessionId: cr.session_id,
          };
        }
        recordPing(r.handle, new Date(), meta);
      }
    }
    const failed = results.filter((r) => !r.success).length;
    if (failed > 0) {
      console.log(`\n${failed}/${results.length} failed`);
      process.exit(1);
    }
    console.log(`\nAll ${results.length} accounts pinged successfully`);
    console.log("\nWindow resets:");
    for (const r of results) {
      const window = getWindowReset(r.handle);
      if (window) {
        console.log(
          `  ${r.handle}: resets in ${formatTimeRemaining(window.remainingMs)}`,
        );
      }
    }
  });

program
  .command("scan")
  .description("Auto-discover accounts from ~/.claude-accounts/")
  .option("--dry-run", "Show what would be added without saving", false)
  .action((opts) => {
    const found = scanAccounts();
    if (found.length === 0) {
      console.log("No accounts found in ~/.claude-accounts/");
      return;
    }
    console.log(`Found ${found.length} account(s):`);
    for (const a of found) {
      console.log(`  ${a.handle} -> ${a.configDir}`);
    }
    if (!opts.dryRun) {
      saveConfig({ accounts: found });
      console.log("\nSaved to config.");
    }
    const dupes = findDuplicates(found);
    if (dupes.size > 0) {
      console.log(
        "\nWarning: duplicate accounts detected (same underlying identity):",
      );
      for (const group of dupes.values()) {
        console.log(`  ${group.handles.join(", ")} (${group.email})`);
      }
    }
  });

program
  .command("add")
  .description("Add an account manually")
  .argument("<handle>", "Account handle/name")
  .argument("<config-dir>", "Path to the CLAUDE_CONFIG_DIR for this account")
  .action((handle, configDir) => {
    addAccount(handle, configDir);
    console.log(`Added: ${handle} -> ${configDir}`);
  });

program
  .command("remove")
  .description("Remove an account")
  .argument("<handle>", "Account handle to remove")
  .action((handle) => {
    if (removeAccount(handle)) {
      console.log(`Removed: ${handle}`);
    } else {
      console.error(`Account not found: ${handle}`);
      process.exit(1);
    }
  });

program
  .command("list")
  .description("List configured accounts")
  .action(() => {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      console.log("No accounts configured");
      return;
    }
    for (const a of accounts) {
      console.log(`  ${a.handle} -> ${a.configDir}`);
    }
  });

program
  .command("status")
  .description("Show status of all accounts with window information")
  .option("--json", "Output as JSON", false)
  .action((opts) => {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      console.log("No accounts configured");
      return;
    }
    const dupes = findDuplicates(accounts);
    const statuses = getAccountStatuses(accounts, new Date(), dupes);
    if (opts.json) {
      console.log(JSON.stringify(statuses, null, 2));
      return;
    }
    for (const s of statuses) {
      console.log(formatStatusLine(s));
    }
  });

program.parse();
