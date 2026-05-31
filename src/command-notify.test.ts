import type { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runNotifyCommand } from "./command-notify.js";

type ExecCallback = (error: Error | null) => void;

interface CapturedCall {
  file: string;
  args: string[];
  // biome-ignore lint/suspicious/noExplicitAny: test inspects the options bag loosely
  options: any;
  cb: ExecCallback;
}

function makeExec() {
  const kill = vi.fn();
  let errorListener: (() => void) | undefined;
  const child = {
    kill,
    on: vi.fn((event: string, listener: () => void) => {
      if (event === "error") errorListener = listener;
      return child;
    }),
  };
  let captured: CapturedCall | undefined;
  const exec = vi.fn(
    (file: string, args: string[], options: unknown, cb: ExecCallback) => {
      captured = { file, args, options, cb };
      return child;
    },
  );
  return {
    exec: exec as unknown as typeof execFile,
    kill,
    triggerError: () => errorListener?.(),
    get call(): CapturedCall {
      if (!captured) throw new Error("exec was not called");
      return captured;
    },
  };
}

const PAYLOAD = {
  title: "t",
  body: "b",
  event: "failure",
  priority: "high",
};

// Inert timers so mock-driven tests never schedule a real hard-kill.
const noTimers = {
  setTimeout: vi.fn(() => 0 as unknown as ReturnType<typeof setTimeout>),
  clearTimeout: vi.fn(),
};

describe("runNotifyCommand", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns false and logs when the command is empty", async () => {
    const log = vi.fn();
    const result = await runNotifyCommand([], PAYLOAD, { log });
    expect(result).toBe(false);
    expect(log).toHaveBeenCalledWith(
      "command notification skipped: empty command",
    );
  });

  it("returns false for an empty command without a logger", async () => {
    expect(await runNotifyCommand([], PAYLOAD)).toBe(false);
  });

  it("runs the command with payload env vars and resolves true on success", async () => {
    const m = makeExec();
    process.env.CC_PING_SPREAD_PROBE = "inherited";
    const result = runNotifyCommand(
      ["notify-send", "-u", "critical"],
      PAYLOAD,
      {
        execFile: m.exec,
        ...noTimers,
      },
    );
    m.call.cb(null);

    expect(await result).toBe(true);
    expect(m.call.file).toBe("notify-send");
    expect(m.call.args).toEqual(["-u", "critical"]);
    expect(m.call.options.env.CC_PING_TITLE).toBe("t");
    expect(m.call.options.env.CC_PING_BODY).toBe("b");
    expect(m.call.options.env.CC_PING_EVENT).toBe("failure");
    expect(m.call.options.env.CC_PING_PRIORITY).toBe("high");
    expect(m.call.options.env.CC_PING_SPREAD_PROBE).toBe("inherited");
    expect(m.call.options.killSignal).toBe("SIGTERM");
    expect(m.call.options.windowsHide).toBe(true);
    expect(m.call.options.timeout).toBe(10_000);
    expect(noTimers.clearTimeout).toHaveBeenCalled();
    delete process.env.CC_PING_SPREAD_PROBE;
  });

  it("resolves false when the command exits non-zero", async () => {
    const m = makeExec();
    const result = runNotifyCommand(["false"], PAYLOAD, {
      execFile: m.exec,
      ...noTimers,
    });
    m.call.cb(new Error("exit 1"));
    expect(await result).toBe(false);
  });

  it("resolves false when the command cannot be spawned", async () => {
    const m = makeExec();
    const result = runNotifyCommand(["does-not-exist"], PAYLOAD, {
      execFile: m.exec,
      ...noTimers,
    });
    m.triggerError();
    expect(await result).toBe(false);
  });

  it("force-kills and resolves false when the command hangs past the deadline", async () => {
    const m = makeExec();
    let hardKill: () => void = () => {};
    const setT = vi.fn((fn: () => void) => {
      hardKill = fn;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    const result = runNotifyCommand(["sleep", "999"], PAYLOAD, {
      execFile: m.exec,
      setTimeout: setT,
      clearTimeout: vi.fn(),
      timeoutMs: 50,
      hardKillMs: 100,
    });
    // The callback never fires; the deadline elapses instead.
    hardKill();

    expect(await result).toBe(false);
    expect(m.kill).toHaveBeenCalledWith("SIGKILL");
    expect(m.call.options.timeout).toBe(50);
    expect(setT).toHaveBeenCalledWith(expect.any(Function), 100);
  });

  it("ignores a late event after it has already resolved", async () => {
    const m = makeExec();
    const result = runNotifyCommand(["cmd"], PAYLOAD, {
      execFile: m.exec,
      ...noTimers,
    });
    m.call.cb(null);
    m.triggerError(); // second resolution attempt — must be ignored

    expect(await result).toBe(true);
  });

  it("uses the real execFile and timers when deps are omitted", async () => {
    const result = await runNotifyCommand(
      [process.execPath, "-e", "process.exit(0)"],
      PAYLOAD,
    );
    expect(result).toBe(true);
  });
});
