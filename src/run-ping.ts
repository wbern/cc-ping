import { ringBell } from "./bell.js";
import { green, red } from "./color.js";
import { runNotifyCommand } from "./command-notify.js";
import { getNotifyCommand, getRemoteNotify } from "./config.js";
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
  notifyCommand?: string[];
  _sendCommand?: typeof runNotifyCommand;
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
  // handle -> ISO reset instant for accounts that failed with a rate limit
  // whose body named a reset time. The daemon sleeps until the soonest of
  // these instead of blind-retrying on a short interval.
  rateLimitResets?: Record<string, string>;
}

// Events that notify by default when no explicit `events` filter is set.
// "rate-limited" is intentionally excluded: a rate limit is expected and
// self-resolving, so alerting on it (potentially every retry) is just noise.
// Users opt in by listing "rate-limited" in remoteNotify.events.
const DEFAULT_NOTIFY_EVENTS: RemoteNotifyEvent[] = ["failure", "new-window"];

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
  const notifyCommand = options.notifyCommand ?? getNotifyCommand();
  const sendCommand = options._sendCommand ?? runNotifyCommand;
  // Both the remote push and the user command are best-effort and awaited
  // together under one deadline so a one-shot `ping` doesn't cut them off.
  const externalPromises: Promise<void>[] = [];
  const fireRemote = (
    event: RemoteNotifyEvent,
    title: string,
    body: string,
    priority: string,
  ) => {
    if (!remoteNotify?.url) return;
    const events = remoteNotify.events ?? DEFAULT_NOTIFY_EVENTS;
    if (!events.includes(event)) return;
    externalPromises.push(
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
  const fireCommand = (
    event: RemoteNotifyEvent,
    title: string,
    body: string,
    priority: string,
  ) => {
    if (!notifyCommand || notifyCommand.length === 0) return;
    // Command notify has no per-event config yet, so it follows the default
    // set — rate-limit events stay off until that opt-in exists.
    if (!DEFAULT_NOTIFY_EVENTS.includes(event)) return;
    externalPromises.push(
      sendCommand(
        notifyCommand,
        { title, body, event, priority },
        {
          log: logger.error,
        },
      )
        .then((ok) => {
          if (!ok) logger.error(`Command notification failed (${event})`);
        })
        .catch(() => logger.error(`Command notification error (${event})`)),
    );
  };

  if (failed > 0 && !options.quietFailure) {
    // A rate limit is expected and self-resolving — separate it from genuine
    // failures (timeouts, auth, billing) so it can notify on its own quiet
    // channel instead of riding the high-priority failure alert.
    const failures = results.filter((r) => !r.success);
    const rateLimited = failures.filter(
      (r) => r.claudeResponse?.api_error_status === 429,
    );
    const genuineFailures = failures.filter(
      (r) => r.claudeResponse?.api_error_status !== 429,
    );

    if (genuineFailures.length > 0) {
      const detail = genuineFailures
        .map((r) => (r.error ? `${r.handle} (${r.error})` : r.handle))
        .join(", ");
      const body = `${genuineFailures.length} account(s) failed: ${detail}`;
      if (options.notify) {
        await sendNotification("cc-ping: ping failure", body);
      }
      fireRemote("failure", "cc-ping: ping failure", body, "high");
      fireCommand("failure", "cc-ping: ping failure", body, "high");
    }

    if (rateLimited.length > 0) {
      // Desktop (--notify) and command channels have no per-event opt-in, so
      // rate-limit alerts go only to the remote channel, which is gated by
      // remoteNotify.events. fireRemote/fireCommand enforce the default-off.
      const body = rateLimited
        .map((r) => `${r.handle}: ${r.error ?? "rate limited"}`)
        .join(", ");
      fireRemote("rate-limited", "cc-ping: rate limited", body, "default");
      fireCommand("rate-limited", "cc-ping: rate limited", body, "default");
    }
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
    fireCommand("new-window", "cc-ping: new window", body, "default");
  }

  await settleWithDeadline(
    externalPromises,
    options._remoteDeadlineMs ?? REMOTE_BATCH_DEADLINE_MS,
  );

  const failedHandles = results.filter((r) => !r.success).map((r) => r.handle);
  const failureReasons: Record<string, string> = {};
  const rateLimitResets: Record<string, string> = {};
  for (const r of results) {
    if (!r.success && r.error) failureReasons[r.handle] = r.error;
    if (r.rateLimitResetAt) {
      rateLimitResets[r.handle] = r.rateLimitResetAt.toISOString();
    }
  }
  const resets =
    Object.keys(rateLimitResets).length > 0 ? rateLimitResets : undefined;

  if (options.json) {
    const jsonResults = results.map((r) => ({
      handle: r.handle,
      success: r.success,
      durationMs: r.durationMs,
      error: r.error,
    }));
    stdout(JSON.stringify(jsonResults, null, 2));
    return {
      exitCode: failed > 0 ? 1 : 0,
      failedHandles,
      failureReasons,
      rateLimitResets: resets,
    };
  }

  if (failed > 0) {
    logger.error(`${failed}/${results.length} failed`);
    return {
      exitCode: 1,
      failedHandles,
      failureReasons,
      rateLimitResets: resets,
    };
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
