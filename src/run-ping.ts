import { ringBell } from "./bell.js";
import { green, red } from "./color.js";
import { appendHistoryEntry } from "./history.js";
import { createLogger } from "./logger.js";
import { sendNotification } from "./notify.js";
import { pingAccounts } from "./ping.js";
import { formatTimeRemaining, getWindowReset, recordPing } from "./state.js";
import type { AccountConfig, PingMeta, PingResult } from "./types.js";

interface RunPingOptions {
  parallel: boolean;
  quiet: boolean;
  json?: boolean;
  bell?: boolean;
  notify?: boolean;
  staggerMs?: number;
  wakeDelayMs?: number;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
  _sleep?: (ms: number) => Promise<void>;
}

export async function runPing(
  accounts: AccountConfig[],
  options: RunPingOptions,
): Promise<number> {
  const stdout = options.stdout ?? console.log;
  const logger = createLogger({
    quiet: options.quiet || options.json === true,
    stdout,
    stderr: options.stderr,
  });

  const hadNoWindow = new Set<string>();
  for (const a of accounts) {
    if (!getWindowReset(a.handle)) {
      hadNoWindow.add(a.handle);
    }
  }

  logger.log(`Pinging ${accounts.length} account(s)...`);
  const sleep =
    options._sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let results: PingResult[];

  if (options.staggerMs && options.staggerMs > 0 && accounts.length > 1) {
    results = [];
    for (let i = 0; i < accounts.length; i++) {
      if (i > 0) {
        const minutes = Math.round(options.staggerMs / 60_000);
        logger.log(`  waiting ${minutes}m before next ping...`);
        await sleep(options.staggerMs);
      }
      const [result] = await pingAccounts([accounts[i]], {});
      results.push(result);
    }
  } else {
    results = await pingAccounts(accounts, {
      parallel: options.parallel,
    });
  }

  const total = results.length;
  for (let idx = 0; idx < results.length; idx++) {
    const r = results[idx];
    const status = r.success ? green("ok") : red("FAIL");
    const detail = r.error ? ` (${r.error})` : "";
    logger.log(
      `  [${idx + 1}/${total}] ${r.handle}: ${status} ${r.durationMs}ms${detail}`,
    );
    appendHistoryEntry({
      timestamp: new Date().toISOString(),
      handle: r.handle,
      success: r.success,
      durationMs: r.durationMs,
      error: r.error,
    });
    if (r.success) {
      let meta: PingMeta | undefined;
      if (r.claudeResponse) {
        meta = {
          costUsd: r.claudeResponse.total_cost_usd,
          inputTokens: r.claudeResponse.usage.input_tokens,
          outputTokens: r.claudeResponse.usage.output_tokens,
          model: r.claudeResponse.model,
          sessionId: r.claudeResponse.session_id,
        };
      }
      recordPing(r.handle, new Date(), meta);
    }
  }

  const failed = results.filter((r) => !r.success).length;

  if (failed > 0 && options.bell) {
    ringBell();
  }

  if (failed > 0 && options.notify) {
    const failedHandles = results
      .filter((r) => !r.success)
      .map((r) => r.handle);
    await sendNotification(
      "cc-ping: ping failure",
      `${failed} account(s) failed: ${failedHandles.join(", ")}`,
    );
  }

  if (options.notify) {
    const newWindows = results
      .filter((r) => r.success && hadNoWindow.has(r.handle))
      .map((r) => r.handle);
    if (newWindows.length > 0) {
      let body = `${newWindows.length} account(s) ready: ${newWindows.join(", ")}`;
      if (options.wakeDelayMs) {
        body += ` (woke ${formatTimeRemaining(options.wakeDelayMs)} late)`;
      }
      await sendNotification("cc-ping: new window", body, { sound: true });
    }
  }

  if (options.json) {
    const jsonResults = results.map((r) => ({
      handle: r.handle,
      success: r.success,
      durationMs: r.durationMs,
      error: r.error,
    }));
    stdout(JSON.stringify(jsonResults, null, 2));
    return failed > 0 ? 1 : 0;
  }

  if (failed > 0) {
    logger.error(`${failed}/${results.length} failed`);
    return 1;
  }

  logger.log(`\nAll ${results.length} accounts pinged successfully`);
  logger.log("\nWindow resets:");
  for (const r of results) {
    const window = getWindowReset(r.handle);
    if (window) {
      logger.log(
        `  ${r.handle}: resets in ${formatTimeRemaining(window.remainingMs)}`,
      );
    }
  }

  return 0;
}
