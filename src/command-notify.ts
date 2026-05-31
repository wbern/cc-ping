// Generic notification channel: runs a user-configured command on notification
// events. The payload is delivered through CC_PING_* environment variables, NOT
// interpolated into the command, and the command is spawned directly (no shell)
// so a title or body containing shell metacharacters can never be a command
// injection vector. Best-effort: a failing or hung command returns false and
// never throws into the caller.

import {
  type ChildProcess,
  execFile as defaultExecFile,
} from "node:child_process";

type ExecFileFn = typeof defaultExecFile;

interface CommandNotifyPayload {
  title: string;
  body: string;
  event: string;
  priority: string;
}

interface CommandNotifyDeps {
  execFile?: ExecFileFn;
  log?: (msg: string) => void;
  timeoutMs?: number;
  hardKillMs?: number;
  setTimeout?: (
    handler: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

// SIGTERM is sent after timeoutMs; if the child ignores it the execFile callback
// never fires, so a separate timer force-resolves (and SIGKILLs) after hardKillMs.
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_HARD_KILL_MS = 15_000;
const MAX_BUFFER = 256 * 1024;

export function runNotifyCommand(
  argv: string[],
  payload: CommandNotifyPayload,
  deps: CommandNotifyDeps = {},
): Promise<boolean> {
  const [file, ...args] = argv;
  if (!file) {
    deps.log?.("command notification skipped: empty command");
    return Promise.resolve(false);
  }

  const exec = deps.execFile ?? defaultExecFile;
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const hardKillMs = deps.hardKillMs ?? DEFAULT_HARD_KILL_MS;

  return new Promise<boolean>((resolve) => {
    let resolved = false;
    let hardKill: ReturnType<typeof setTimeout>;
    const done = (ok: boolean) => {
      if (resolved) return;
      resolved = true;
      clearT(hardKill);
      resolve(ok);
    };

    const child: ChildProcess = exec(
      file,
      args,
      {
        env: {
          ...process.env,
          CC_PING_TITLE: payload.title,
          CC_PING_BODY: payload.body,
          CC_PING_EVENT: payload.event,
          CC_PING_PRIORITY: payload.priority,
        },
        timeout: timeoutMs,
        killSignal: "SIGTERM",
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
      },
      (error) => done(!error),
    );

    hardKill = setT(() => {
      child.kill("SIGKILL");
      done(false);
    }, hardKillMs);

    // Covers ENOENT (command not found) and other spawn failures, which arrive
    // via the 'error' event rather than the callback.
    child.on("error", () => done(false));
  });
}
