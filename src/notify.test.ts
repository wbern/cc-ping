import { describe, expect, it, vi } from "vitest";
import { buildNotifyCommand, sendNotification } from "./notify.js";

describe("buildNotifyCommand", () => {
  it("returns osascript command on darwin", () => {
    const [cmd, args] = buildNotifyCommand("Title", "Body text", "darwin")!;
    expect(cmd).toBe("osascript");
    expect(args).toContain("-e");
    expect(args[1]).toContain("Title");
    expect(args[1]).toContain("Body text");
    expect(args[1]).not.toContain("sound name");
  });

  it("includes sound name in osascript command when sound option is true", () => {
    const [cmd, args] = buildNotifyCommand("Title", "Body text", "darwin", {
      sound: true,
    })!;
    expect(cmd).toBe("osascript");
    expect(args[1]).toContain('sound name "default"');
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

    const result = await sendNotification("Title", "Body", {
      platform: "darwin",
      exec,
    });
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

    const result = await sendNotification("Title", "Body", {
      platform: "darwin",
      exec,
    });
    expect(result).toBe(false);
  });

  it("returns false on unsupported platform", async () => {
    const exec = vi.fn();
    const result = await sendNotification("Title", "Body", {
      platform: "freebsd",
      exec,
    });
    expect(result).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("uses platform and exec defaults when opts not provided", async () => {
    const result = await sendNotification("Title", "Body");
    expect(typeof result).toBe("boolean");
  });

  it("passes sound option through to osascript command", async () => {
    const exec = vi.fn(
      (_cmd: string, _args: string[], cb: (error: Error | null) => void) =>
        cb(null),
    );

    await sendNotification("Title", "Body", {
      platform: "darwin",
      exec,
      sound: true,
    });
    const args = exec.mock.calls[0][1] as string[];
    expect(args[1]).toContain('sound name "default"');
  });
});
