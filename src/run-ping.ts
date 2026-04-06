import { appendHistoryEntry } from "./history.js";
import { createLogger } from "./logger.js";
import { pingAccounts } from "./ping.js";
import { formatTimeRemaining, getWindowReset, recordPing } from "./state.js";
import type { AccountConfig, PingMeta } from "./types.js";

interface RunPingOptions {
  parallel: boolean;
  quiet: boolean;
  json?: boolean;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
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

  logger.log(`Pinging ${accounts.length} account(s)...`);
  const results = await pingAccounts(accounts, {
    parallel: options.parallel,
  });

  for (const r of results) {
    const status = r.success ? "ok" : "FAIL";
    const detail = r.error ? ` (${r.error})` : "";
    const cr = r.claudeResponse;
    const costInfo = cr
      ? `  $${cr.total_cost_usd.toFixed(4)} ${cr.usage.input_tokens + cr.usage.output_tokens} tok`
      : "";
    logger.log(
      `  ${r.handle}: ${status} ${r.durationMs}ms${detail}${costInfo}`,
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
