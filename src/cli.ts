import { Command } from "commander";
import { checkAccounts } from "./check.js";
import { generateCompletion } from "./completions.js";
import {
  addAccount,
  listAccounts,
  removeAccount,
  saveConfig,
} from "./config.js";
import {
  getDaemonStatus,
  runDaemonWithDefaults,
  startDaemon,
  stopDaemon,
} from "./daemon.js";
import { filterAccounts, filterByGroup } from "./filter-accounts.js";
import { formatHistoryEntry, readHistory } from "./history.js";
import { findDuplicates } from "./identity.js";
import { getNextReset } from "./next-reset.js";
import { setConfigDir } from "./paths.js";
import { runPing } from "./run-ping.js";
import { scanAccounts } from "./scan.js";
import { parseStagger } from "./stagger.js";
import { formatStatusLine, getAccountStatuses } from "./status.js";
import { suggestAccount } from "./suggest.js";

declare const __VERSION__: string;

const program = new Command()
  .name("cc-ping")
  .description("Ping Claude Code sessions to trigger quota windows early")
  .version(__VERSION__)
  .option(
    "--config <path>",
    "Path to config directory (default: ~/.config/cc-ping, env: CC_PING_CONFIG)",
  )
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.config) {
      setConfigDir(opts.config);
    }
  });

program
  .command("ping")
  .description("Ping configured accounts to start quota windows")
  .argument("[handles...]", "Specific account handles to ping (default: all)")
  .option("--parallel", "Ping all accounts in parallel", false)
  .option("-q, --quiet", "Suppress all output except errors (for cron)", false)
  .option("--json", "Output results as JSON", false)
  .option("-g, --group <group>", "Ping only accounts in this group")
  .option("--bell", "Ring terminal bell on ping failure", false)
  .option("--notify", "Send desktop notification on ping failure", false)
  .option(
    "--stagger <minutes|auto>",
    "Delay between account pings (minutes or 'auto')",
  )
  .action(async (handles: string[], opts) => {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      console.error(
        "No accounts configured. Run: cc-ping scan or cc-ping add <handle> <dir>",
      );
      process.exit(1);
    }
    const targets = filterAccounts(
      filterByGroup(accounts, opts.group),
      handles,
    );
    const staggerMs = opts.stagger
      ? parseStagger(opts.stagger, targets.length)
      : undefined;
    const exitCode = await runPing(targets, {
      parallel: opts.parallel,
      quiet: opts.quiet,
      json: opts.json,
      bell: opts.bell,
      notify: opts.notify,
      staggerMs,
    });
    process.exit(exitCode);
  });

program
  .command("check")
  .description(
    "Verify account config directories are valid and have credentials",
  )
  .option("--json", "Output as JSON", false)
  .action((opts) => {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      console.log("No accounts configured");
      return;
    }
    const results = checkAccounts(accounts);
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    for (const r of results) {
      const status = r.healthy ? "healthy" : "UNHEALTHY";
      const issues = r.issues.length > 0 ? ` (${r.issues.join("; ")})` : "";
      console.log(`  ${r.handle}: ${status}${issues}`);
    }
    const unhealthy = results.filter((r) => !r.healthy).length;
    if (unhealthy > 0) {
      process.exit(1);
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
  .option("-g, --group <group>", "Assign account to a group")
  .action((handle, configDir, opts) => {
    addAccount(handle, configDir, opts.group);
    const groupInfo = opts.group ? ` [${opts.group}]` : "";
    console.log(`Added: ${handle} -> ${configDir}${groupInfo}`);
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
  .option("--json", "Output as JSON", false)
  .action((opts) => {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      console.log(opts.json ? "[]" : "No accounts configured");
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(accounts, null, 2));
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

program
  .command("next-reset")
  .description("Show which account has its quota window resetting soonest")
  .option("--json", "Output as JSON", false)
  .action((opts) => {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      console.log("No accounts configured");
      return;
    }
    const result = getNextReset(accounts);
    if (!result) {
      console.log("No active quota windows");
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `${result.handle}: resets in ${result.timeUntilReset} (${result.configDir})`,
    );
  });

program
  .command("suggest")
  .description("Suggest which account to use next based on quota window state")
  .option("--json", "Output as JSON", false)
  .action((opts) => {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      console.log("No accounts configured");
      return;
    }
    const result = suggestAccount(accounts);
    if (!result) {
      console.log("No accounts configured");
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const resetInfo = result.timeUntilReset
      ? `, resets in ${result.timeUntilReset}`
      : "";
    console.log(
      `${result.handle} (${result.reason}${resetInfo}) -> ${result.configDir}`,
    );
  });

program
  .command("history")
  .description("Show recent ping history")
  .option("--limit <n>", "Number of entries to show", "20")
  .option("--json", "Output as JSON", false)
  .action((opts) => {
    const limit = Number.parseInt(opts.limit, 10);
    const entries = readHistory(limit);
    if (entries.length === 0) {
      console.log(opts.json ? "[]" : "No ping history");
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }
    for (const entry of entries) {
      console.log(formatHistoryEntry(entry));
    }
  });

program
  .command("completions")
  .description("Generate shell completion script")
  .argument("<shell>", "Shell type: bash, zsh, or fish")
  .action((shell: string) => {
    console.log(generateCompletion(shell));
  });

const daemon = program
  .command("daemon")
  .description("Run auto-ping on a schedule");

daemon
  .command("start")
  .description("Start the daemon process")
  .option(
    "--interval <minutes>",
    "Ping interval in minutes (default: 300 = 5h quota window)",
  )
  .option("-q, --quiet", "Suppress ping output", false)
  .option("--bell", "Ring terminal bell on ping failure", false)
  .option("--notify", "Send desktop notification on ping failure", false)
  .action((opts) => {
    const result = startDaemon({
      interval: opts.interval,
      quiet: opts.quiet,
      bell: opts.bell,
      notify: opts.notify,
    });
    if (!result.success) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(`Daemon started (PID: ${result.pid})`);
  });

daemon
  .command("stop")
  .description("Stop the daemon process")
  .action(async () => {
    const result = await stopDaemon();
    if (!result.success) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(`Daemon stopped (PID: ${result.pid})`);
  });

daemon
  .command("status")
  .description("Show daemon status")
  .option("--json", "Output as JSON", false)
  .action((opts) => {
    const status = getDaemonStatus();
    if (opts.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    if (!status.running) {
      console.log("Daemon is not running");
      return;
    }
    console.log(`Daemon is running (PID: ${status.pid})`);
    console.log(`  Started: ${status.startedAt}`);
    console.log(
      `  Interval: ${Math.round((status.intervalMs ?? 0) / 60_000)}m`,
    );
    console.log(`  Uptime: ${status.uptime}`);
  });

daemon
  .command("_run", { hidden: true })
  .option("--interval-ms <ms>", "Ping interval in milliseconds")
  .option("-q, --quiet", "Suppress ping output", false)
  .option("--bell", "Ring terminal bell on ping failure", false)
  .option("--notify", "Send desktop notification on ping failure", false)
  .action(async (opts) => {
    const intervalMs = Number(opts.intervalMs);
    if (!intervalMs || intervalMs <= 0) {
      console.error("Invalid --interval-ms");
      process.exit(1);
    }
    await runDaemonWithDefaults(intervalMs, {
      quiet: opts.quiet,
      bell: opts.bell,
      notify: opts.notify,
    });
  });

program.parse();
