import { describe, expect, it, vi } from "vitest";
import { buildNotifyCommand, sendNotification } from "./notify.js";

describe("buildNotifyCommand", () => {
  it("returns osascript command on darwin", () => {
    const [cmd, args] = buildNotifyCommand("Title", "Body text", "darwin")!;
    expect(cmd).toBe("osascript");
    expect(args).toContain("-e");
    expect(args[1]).toContain("Title");
    expect(args[1]).toContain("Body text");
  });

  it("returns notify-send command on linux", () => {
    const [cmd, args] = buildNotifyCommand("Title", "Body text", "linux")!;
    expect(cmd).toBe("notify-send");
    expect(args).toContain("Title");
    expect(args).toContain("Body text");
  });

  it("returns powershell command on win32", () => {
    const [cmd, args] = buildNotifyCommand("Title", "Body text", "win32")!;
    expect(cmd).toBe("powershell");
    expect(args.join(" ")).toContain("Title");
    expect(args.join(" ")).toContain("Body text");
  });

  it("returns null for unsupported platform", () => {
    const result = buildNotifyCommand("Title", "Body", "freebsd");
    expect(result).toBeNull();
  });
});

describe("sendNotification", () => {
  it("calls execFile with correct command", async () => {
    const exec = vi.fn(
      (_cmd: string, _args: string[], cb: (error: Error | null) => void) =>
        cb(null),
    );

    const result = await sendNotification("Title", "Body", "darwin", exec);
    expect(result).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      "osascript",
      expect.any(Array),
      expect.any(Function),
    );
  });

  it("returns false on exec error", async () => {
    const exec = vi.fn(
      (_cmd: string, _args: string[], cb: (error: Error | null) => void) =>
        cb(new Error("not found")),
    );

    const result = await sendNotification("Title", "Body", "darwin", exec);
    expect(result).toBe(false);
  });

  it("returns false on unsupported platform", async () => {
    const exec = vi.fn();
    const result = await sendNotification("Title", "Body", "freebsd", exec);
    expect(result).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});
