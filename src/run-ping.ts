import { ringBell } from "./bell.js";
import { green, red } from "./color.js";
import { getRemoteNotify } from "./config.js";
import { appendHistoryEntry } from "./history.js";
import { createLogger } from "./logger.js";
import { sendNotification } from "./notify.js";
import { isAuthError, pingAccounts } from "./ping.js";
import { sendRemoteNotification } from "./remote-notify.js";
import {
  formatTimeRemaining,
  getWindowReset,
  recordAuthFailure,
  recordPing,
} from "./state.js";
import type {
  AccountConfig,
  PingMeta,
  PingResult,
  RemoteNotifyConfig,
  RemoteNotifyEvent,
} from "./types.js";

interface RunPingOptions {
  parallel: boolean;
  quiet: boolean;
  json?: boolean;
  bell?: boolean;
  notify?: boolean;
  quietFailure?: boolean;
  staggerMs?: number;
  wakeDelayMs?: number;
  signal?: AbortSignal;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
  _sleep?: (ms: number) => Promise<void>;
  remoteNotify?: RemoteNotifyConfig;
  _sendRemote?: typeof sendRemoteNotification;
  _remoteDeadlineMs?: number;
}

// A one-shot `cc-ping ping` calls process.exit right after runPing returns, so
// we await the remote POSTs to avoid cutting them off mid-flight — but never
// longer than this, so an unreachable endpoint can't stall the command.
const REMOTE_BATCH_DEADLINE_MS = 8_000;

function settleWithDeadline(
  promises: Promise<void>[],
  deadlineMs: number,
): Promise<void> {
  if (promises.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, deadlineMs);
    Promise.allSettled(promises).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

interface RunPingResult {
  exitCode: number;
  failedHandles: string[];
  failureReasons?: Record<string, string>;
}

export async function runPing(
  accounts: AccountConfig[],
  options: RunPingOptions,
): Promise<RunPingResult> {
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
      const [result] = await pingAccounts([accounts[i]], {
        signal: options.signal,
      });
      results.push(result);
    }
  } else {
    results = await pingAccounts(accounts, {
      parallel: options.parallel,
      signal: options.signal,
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
    } else if (r.claudeResponse && isAuthError(r.claudeResponse)) {
      // Session auth expired — flag it so `cc-ping login` can re-auth it.
      recordAuthFailure(r.handle);
    }
  }

  const failed = results.filter((r) => !r.success).length;

  if (failed > 0 && options.bell) {
    ringBell();
  }

  // Remote (phone) notifications fire independently of --notify so a headless
  // daemon can alert a phone even without a desktop. Best-effort: a failed POST
  // is logged and never fails the ping.
  const remoteNotify = options.remoteNotify ?? getRemoteNotify();
  const sendRemote = options._sendRemote ?? sendRemoteNotification;
  const remotePromises: Promise<void>[] = [];
  const fireRemote = (
    event: RemoteNotifyEvent,
    title: string,
    body: string,
    priority: string,
  ) => {
    if (!remoteNotify?.url) return;
    if (remoteNotify.events && !remoteNotify.events.includes(event)) return;
    remotePromises.push(
      sendRemote(
        remoteNotify.url,
        { title, body, priority },
        { log: logger.error },
      )
        .then((ok) => {
          if (!ok) logger.error(`Remote notification failed (${event})`);
        })
        .catch(() => logger.error(`Remote notification error (${event})`)),
    );
  };

  if (failed > 0 && !options.quietFailure) {
    const failures = results
      .filter((r) => !r.success)
      .map((r) => (r.error ? `${r.handle} (${r.error})` : r.handle));
    const body = `${failed} account(s) failed: ${failures.join(", ")}`;
    if (options.notify) {
      await sendNotification("cc-ping: ping failure", body);
    }
    fireRemote("failure", "cc-ping: ping failure", body, "high");
  }

  const newWindows = results
    .filter((r) => r.success && hadNoWindow.has(r.handle))
    .map((r) => r.handle);
  if (newWindows.length > 0) {
    let body = `${newWindows.length} account(s) ready: ${newWindows.join(", ")}`;
    if (options.wakeDelayMs) {
      body += ` (woke ${formatTimeRemaining(options.wakeDelayMs)} late)`;
    }
    if (options.notify) {
      await sendNotification("cc-ping: new window", body, { sound: true });
    }
    fireRemote("new-window", "cc-ping: new window", body, "default");
  }

  await settleWithDeadline(
    remotePromises,
    options._remoteDeadlineMs ?? REMOTE_BATCH_DEADLINE_MS,
  );

  const failedHandles = results.filter((r) => !r.success).map((r) => r.handle);
  const failureReasons: Record<string, string> = {};
  for (const r of results) {
    if (!r.success && r.error) failureReasons[r.handle] = r.error;
  }

  if (options.json) {
    const jsonResults = results.map((r) => ({
      handle: r.handle,
      success: r.success,
      durationMs: r.durationMs,
      error: r.error,
    }));
    stdout(JSON.stringify(jsonResults, null, 2));
    return { exitCode: failed > 0 ? 1 : 0, failedHandles, failureReasons };
  }

  if (failed > 0) {
    logger.error(`${failed}/${results.length} failed`);
    return { exitCode: 1, failedHandles, failureReasons };
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

  return { exitCode: 0, failedHandles: [] };
}
