import { Command } from "commander";
import {
  addAccount,
  listAccounts,
  removeAccount,
  saveConfig,
} from "./config.js";
import { pingAccounts } from "./ping.js";
import { scanAccounts } from "./scan.js";

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
      console.log(`  ${r.handle}: ${status} ${r.durationMs}ms${detail}`);
    }
    const failed = results.filter((r) => !r.success).length;
    if (failed > 0) {
      console.log(`\n${failed}/${results.length} failed`);
      process.exit(1);
    }
    console.log(`\nAll ${results.length} accounts pinged successfully`);
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

program.parse();
