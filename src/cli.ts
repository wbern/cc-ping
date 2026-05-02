import { basename, resolve } from "node:path";
import { Command } from "commander";
import { checkAccounts } from "./check.js";
import { yellow } from "./color.js";
import { generateCompletion } from "./completions.js";
import {
  addAccount,
  listAccounts,
  removeAccount,
  resetSchedule,
  saveConfig,
} from "./config.js";
import {
  getDaemonStatus,
  readDaemonState,
  runDaemonWithDefaults,
  startDaemon,
  stopDaemon,
  writeDaemonState,
} from "./daemon.js";
import { showDefault } from "./default-command.js";
import {
  filterAccounts,
  filterByGroup,
  filterNeedsPing,
} from "./filter-accounts.js";
import { formatTimeAgo } from "./format.js";
import { formatHistoryEntry, readHistory } from "./history.js";
import { findDuplicates } from "./identity.js";
import { getNextReset } from "./next-reset.js";
import { sendNotification } from "./notify.js";
import { setConfigDir } from "./paths.js";
import { runPing } from "./run-ping.js";
import { scanAccounts } from "./scan.js";
import {
  checkRecentActivity,
  parseSmartSchedule,
  readAccountSchedule,
  shouldDefer,
} from "./schedule.js";
import { parseStagger } from "./stagger.js";
import { findOrphanHandles, pruneOrphanState } from "./state.js";
import type { DeferInfo } from "./status.js";
import { getAccountStatuses, printAccountTable } from "./status.js";
import { suggestAccount } from "./suggest.js";

declare const __VERSION__: string;

function getScheduleDeferInfo(
  configDir: string,
  now: Date,
  scheduleResetAt?: string,
): DeferInfo | null {
  const resetAt = scheduleResetAt ? new Date(scheduleResetAt) : undefined;
  const schedule = readAccountSchedule(configDir, now, resetAt);
  if (!schedule) return null;
  return {
    optimalPingHour: schedule.optimalPingHour,
    peakStart: schedule.peakStart,
    peakEnd: schedule.peakEnd,
  };
}

function getDeferredHandles(): Map<string, DeferInfo> {
  const deferred = new Map<string, DeferInfo>();
  const now = new Date();
  for (const account of listAccounts()) {
    const info = getScheduleDeferInfo(
      account.configDir,
      now,
      account.scheduleResetAt,
    );
    if (info && shouldDefer(now, info.optimalPingHour).defer) {
      deferred.set(account.handle, info);
    }
  }
  return deferred;
}

function getCoveredHandles(): Map<string, DeferInfo | null> {
  const covered = new Map<string, DeferInfo | null>();
  const now = new Date();
  for (const account of listAccounts()) {
    if (checkRecentActivity(account.configDir)) {
      covered.set(
        account.handle,
        getScheduleDeferInfo(account.configDir, now, account.scheduleResetAt),
      );
    }
  }
  return covered;
}

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
  })
  .action(() => {
    showDefault(
      console.log,
      new Date(),
      getDeferredHandles(),
      undefined,
      getCoveredHandles(),
    );
  });

program
  .command("ping")
  .description("Ping configured accounts to start quota windows")
  .argument(
    "[handles...]",
    "Specific handles to ping (default: accounts that need it)",
  )
  .option("--parallel", "Ping all accounts in parallel", false)
  .option("-q, --quiet", "Suppress all output except errors (for cron)", false)
  .option("--json", "Output results as JSON", false)
  .option("-g, --group <group>", "Ping only accounts in this group")
  .option("--bell", "Ring terminal bell on ping failure", false)
  .option("--notify", "Desktop notification on new windows and failures", false)
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
    const grouped = filterByGroup(accounts, opts.group);
    const selected =
      handles.length > 0 ? filterAccounts(grouped, handles) : grouped;
    const targets = handles.length > 0 ? selected : filterNeedsPing(selected);
    if (targets.length === 0) {
      console.log("All accounts have active windows. Nothing to ping.");
      process.exit(0);
    }
    const staggerMs = opts.stagger
      ? parseStagger(opts.stagger, targets.length)
      : undefined;
    const { exitCode } = await runPing(targets, {
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
  .description("Auto-discover Claude Code accounts (scans ~ by default)")
  .argument("[dir]", "Directory to scan (default: ~)")
  .option("--dry-run", "Show what would be added without saving", false)
  .action((dir, opts) => {
    const scanDir = dir ? resolve(dir) : undefined;
    const found = scanAccounts(scanDir);
    if (found.length === 0) {
      console.log(`No accounts found in ${scanDir ?? "~"}`);
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
  .argument("<config-dir>", "Path to the CLAUDE_CONFIG_DIR for this account")
  .option(
    "-n, --name <name>",
    "Override account handle (default: directory name)",
  )
  .option("-g, --group <group>", "Assign account to a group")
  .action((configDir, opts) => {
    const handle = opts.name || basename(configDir);
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
  .option("--censor", "Mask account handles in output (for screenshots)")
  .action((opts) => {
    const deferred = getDeferredHandles();
    const covered = getCoveredHandles();
    if (opts.json) {
      const accounts = listAccounts();
      const dupes = findDuplicates(accounts);
      const statuses = getAccountStatuses(
        accounts,
        new Date(),
        dupes,
        deferred,
        covered,
      );
      console.log(JSON.stringify(statuses, null, 2));
      return;
    }
    const daemonStatus = getDaemonStatus({ currentVersion: __VERSION__ });
    printAccountTable(
      console.log,
      new Date(),
      deferred,
      {
        censor: opts.censor,
        daemonNextPingIn: daemonStatus.running
          ? daemonStatus.nextPingIn
          : undefined,
      },
      covered,
    );
  });

program
  .command("next-reset")
  .description("Show which account has its quota window resetting soonest")
  .option("--json", "Output as JSON", false)
  .action((opts) => {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      console.log(opts.json ? "null" : "No accounts configured");
      return;
    }
    const result = getNextReset(accounts);
    if (opts.json) {
      console.log(JSON.stringify(result ?? null, null, 2));
      return;
    }
    if (!result) {
      console.log("No active quota windows");
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
      console.log(opts.json ? "null" : "No accounts configured");
      return;
    }
    const result = suggestAccount(accounts);
    if (opts.json) {
      console.log(JSON.stringify(result ?? null, null, 2));
      return;
    }
    if (!result) {
      console.log("No accounts configured");
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
    const now = new Date();
    for (const entry of entries) {
      console.log(formatHistoryEntry(entry, now));
    }
  });

program
  .command("cleanup")
  .description("Remove orphan state entries for handles no longer configured")
  .option("--dry-run", "Show what would be removed without writing", false)
  .option("--json", "Output as JSON", false)
  .action((opts) => {
    const active = listAccounts().map((a) => a.handle);
    const orphans = opts.dryRun
      ? findOrphanHandles(active)
      : pruneOrphanState(active);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            dryRun: !!opts.dryRun,
            orphans,
            allStateWiped: active.length === 0,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (orphans.length === 0) {
      console.log("No orphan state entries");
      return;
    }
    const verb = opts.dryRun ? "Would remove" : "Removed";
    const scope = active.length === 0 ? " (no accounts configured)" : "";
    console.log(`${verb} ${orphans.length} orphan handle(s)${scope}:`);
    for (const h of orphans) console.log(`  ${h}`);
  });

program
  .command("completions")
  .description("Generate shell completion script")
  .argument("<shell>", "Shell type: bash, zsh, or fish")
  .action((shell: string) => {
    console.log(generateCompletion(shell));
  });

program
  .command("moo")
  .description("Send a test notification to verify desktop notifications work")
  .action(async () => {
    const ok = await sendNotification(
      "cc-ping",
      "Moo! Notifications are working.",
    );
    if (ok) {
      console.log("Notification sent");
    } else {
      console.error(
        "Notification failed (unsupported platform or command error)",
      );
      process.exit(1);
    }
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
  .option("--notify", "Desktop notification on new windows and failures", false)
  .option(
    "--smart-schedule <on|off>",
    "Time pings based on usage patterns (default: on)",
  )
  .option("--censor", "Mask account handles in output (for screenshots)")
  .action(async (opts) => {
    let smartSchedule: boolean | undefined;
    if (opts.smartSchedule !== undefined) {
      smartSchedule = parseSmartSchedule(opts.smartSchedule);
    }
    const result = startDaemon({
      interval: opts.interval,
      quiet: opts.quiet,
      bell: opts.bell,
      notify: opts.notify,
      smartSchedule,
      version: __VERSION__,
    });
    if (!result.success) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(`Daemon started (PID: ${result.pid})`);
    const { getServiceStatus } = await import("./service.js");
    const svc = getServiceStatus();
    if (!svc.installed) {
      console.log(
        "Hint: won't survive a reboot. Use `cc-ping daemon install` for a persistent service.",
      );
    }
    printAccountTable(
      console.log,
      new Date(),
      getDeferredHandles(),
      { censor: opts.censor },
      getCoveredHandles(),
    );
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
    const { getServiceStatus } = await import("./service.js");
    const svc = getServiceStatus();
    if (svc.installed) {
      console.log(
        "Note: system service is installed. The daemon may restart. Use `cc-ping daemon uninstall` to fully remove.",
      );
    }
  });

daemon
  .command("status")
  .description("Show daemon status")
  .option("--json", "Output as JSON", false)
  .option("--censor", "Mask account handles in output (for screenshots)")
  .action(async (opts) => {
    const { getServiceStatus } = await import("./service.js");
    const svc = getServiceStatus();
    const status = getDaemonStatus({ currentVersion: __VERSION__ });
    if (opts.json) {
      const serviceInfo = svc.installed
        ? {
            service: {
              installed: true,
              path: svc.servicePath,
              platform: svc.platform,
            },
          }
        : { service: { installed: false } };
      if (!status.running) {
        console.log(JSON.stringify({ ...status, ...serviceInfo }, null, 2));
        return;
      }
      const accounts = listAccounts();
      const dupes = findDuplicates(accounts);
      const deferred = getDeferredHandles();
      const covered = getCoveredHandles();
      const accountStatuses = getAccountStatuses(
        accounts,
        new Date(),
        dupes,
        deferred,
        covered,
      );
      console.log(
        JSON.stringify(
          { ...status, ...serviceInfo, accounts: accountStatuses },
          null,
          2,
        ),
      );
      return;
    }
    if (!status.running) {
      if (svc.installed) {
        const kind = svc.platform === "darwin" ? "launchd" : "systemd";
        console.log(
          `Daemon is not running (system service: installed via ${kind})`,
        );
      } else {
        console.log("Daemon is not running");
      }
      return;
    }
    console.log(`Daemon is running (PID: ${status.pid})`);
    if (status.daemonVersion) {
      console.log(`  Version: ${status.daemonVersion}`);
    }
    console.log(
      `  Started: ${status.startedAt ? formatTimeAgo(status.startedAt, new Date()) : "unknown"}`,
    );
    console.log(
      `  Interval: ${Math.round((status.intervalMs ?? 0) / 60_000)}m`,
    );
    console.log(`  Uptime: ${status.uptime}`);
    if (status.nextPingIn) {
      console.log(`  Next ping in: ${status.nextPingIn}`);
    }
    if (svc.installed) {
      const kind = svc.platform === "darwin" ? "launchd" : "systemd";
      console.log(`  System service: installed (${kind})`);
    }
    if (status.versionMismatch) {
      console.log(
        yellow(
          `  Warning: daemon is running v${status.daemonVersion} but v${__VERSION__} is installed.`,
        ),
      );
      console.log(
        yellow(
          "  Restart to pick up the new version: cc-ping daemon stop && cc-ping daemon start",
        ),
      );
    }
    console.log("");
    printAccountTable(
      console.log,
      new Date(),
      getDeferredHandles(),
      { censor: opts.censor, daemonNextPingIn: status.nextPingIn },
      getCoveredHandles(),
    );
  });

daemon
  .command("install")
  .description("Install daemon as a system service (launchd/systemd)")
  .option(
    "--interval <minutes>",
    "Ping interval in minutes (default: 300 = 5h quota window)",
  )
  .option("-q, --quiet", "Suppress ping output", false)
  .option("--bell", "Ring terminal bell on ping failure", false)
  .option("--notify", "Desktop notification on new windows and failures", false)
  .option(
    "--smart-schedule <on|off>",
    "Time pings based on usage patterns (default: on)",
  )
  .action(async (opts) => {
    let smartSchedule: boolean | undefined;
    if (opts.smartSchedule !== undefined) {
      smartSchedule = parseSmartSchedule(opts.smartSchedule);
    }
    const { installService } = await import("./service.js");
    const result = await installService({
      interval: opts.interval,
      quiet: opts.quiet,
      bell: opts.bell,
      notify: opts.notify,
      smartSchedule,
    });
    if (!result.success) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(`Service installed: ${result.servicePath}`);
    console.log(
      "The daemon will start automatically on login. Use `cc-ping daemon uninstall` to remove.",
    );
  });

daemon
  .command("uninstall")
  .description("Remove daemon system service")
  .action(async () => {
    const { uninstallService } = await import("./service.js");
    const result = await uninstallService();
    if (!result.success) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(`Service removed: ${result.servicePath}`);
  });

daemon
  .command("_run", { hidden: true })
  .option("--interval-ms <ms>", "Ping interval in milliseconds")
  .option("-q, --quiet", "Suppress ping output", false)
  .option("--bell", "Ring terminal bell on ping failure", false)
  .option("--notify", "Desktop notification on new windows and failures", false)
  .option("--smart-schedule <on|off>", "Smart scheduling (default: on)")
  .option("--auto-update", "Auto-restart on upgrade (for service installs)")
  .action(async (opts) => {
    const intervalMs = Number(opts.intervalMs);
    if (!intervalMs || intervalMs <= 0) {
      console.error("Invalid --interval-ms");
      process.exit(1);
    }
    let smartSchedule: boolean | undefined;
    if (opts.smartSchedule !== undefined) {
      smartSchedule = parseSmartSchedule(opts.smartSchedule);
    }
    // Write state if not already present (e.g. launched by launchd/systemd)
    if (!readDaemonState()) {
      const { resolveConfigDir } = await import("./paths.js");
      writeDaemonState({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        intervalMs,
        configDir: resolveConfigDir(),
        version: __VERSION__,
      });
    }
    await runDaemonWithDefaults(intervalMs, {
      quiet: opts.quiet,
      bell: opts.bell,
      notify: opts.notify,
      smartSchedule,
      autoUpdate: opts.autoUpdate,
    });
  });

const schedule = program
  .command("schedule")
  .description("Manage smart scheduling");

schedule
  .command("reset")
  .description("Reset smart scheduling data to recompute optimal ping times")
  .argument("[handle]", "Specific account handle (default: all accounts)")
  .action((handle?: string) => {
    if (resetSchedule(handle)) {
      if (handle) {
        console.log(`Schedule reset for: ${handle}`);
      } else {
        console.log("Schedule reset for all accounts");
      }
    } else {
      if (handle) {
        console.error(`Account not found: ${handle}`);
        process.exit(1);
      } else {
        console.error("No accounts configured");
        process.exit(1);
      }
    }
  });

program.parse();
