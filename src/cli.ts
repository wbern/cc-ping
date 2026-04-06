import { Command } from "commander";
import {
  addAccount,
  listAccounts,
  removeAccount,
  saveConfig,
} from "./config.js";
import { findDuplicates } from "./identity.js";
import { runPing } from "./run-ping.js";
import { scanAccounts } from "./scan.js";
import { formatStatusLine, getAccountStatuses } from "./status.js";

declare const __VERSION__: string;

const program = new Command()
  .name("cc-ping")
  .description("Ping Claude Code sessions to trigger quota windows early")
  .version(__VERSION__);

program
  .command("ping")
  .description("Ping all configured accounts to start quota windows")
  .option("--parallel", "Ping all accounts in parallel", false)
  .option("-q, --quiet", "Suppress all output except errors (for cron)", false)
  .action(async (opts) => {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      console.error(
        "No accounts configured. Run: cc-ping scan or cc-ping add <handle> <dir>",
      );
      process.exit(1);
    }
    const exitCode = await runPing(accounts, {
      parallel: opts.parallel,
      quiet: opts.quiet,
    });
    process.exit(exitCode);
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
