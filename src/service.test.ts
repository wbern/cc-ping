import { describe, expect, it, vi } from "vitest";
import {
  type ExecInfo,
  generateLaunchdPlist,
  generateSystemdUnit,
  getServiceStatus,
  installService,
  resolveExecutable,
  type ServiceDeps,
  servicePath,
  uninstallService,
} from "./service.js";

function makeDeps(overrides?: Partial<ServiceDeps>): ServiceDeps {
  return {
    platform: "darwin",
    homedir: () => "/Users/test",
    existsSync: () => false,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    execSync: vi.fn().mockReturnValue(""),
    stopDaemon: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

describe("service", () => {
  describe("resolveExecutable", () => {
    it("returns cc-ping path when which succeeds", () => {
      const result = resolveExecutable({
        execSync: () => "/usr/local/bin/cc-ping\n",
      });
      expect(result).toEqual({
        executable: "/usr/local/bin/cc-ping",
        args: [],
      });
    });

    it("falls back to process.execPath when which fails", () => {
      const result = resolveExecutable({
        execSync: () => {
          throw new Error("not found");
        },
      });
      expect(result.executable).toBe(process.execPath);
      expect(result.args).toEqual([process.argv[1]]);
    });

    it("falls back when which returns empty string", () => {
      const result = resolveExecutable({
        execSync: () => "  \n",
      });
      expect(result.executable).toBe(process.execPath);
      expect(result.args).toEqual([process.argv[1]]);
    });
  });

  describe("generateLaunchdPlist", () => {
    const execInfo: ExecInfo = {
      executable: "/usr/local/bin/cc-ping",
      args: [],
    };

    it("generates valid plist with defaults", () => {
      const plist = generateLaunchdPlist({}, execInfo);
      expect(plist).toContain("<?xml version=");
      expect(plist).toContain("<string>com.cc-ping.daemon</string>");
      expect(plist).toContain("<string>/usr/local/bin/cc-ping</string>");
      expect(plist).toContain("<string>daemon</string>");
      expect(plist).toContain("<string>_run</string>");
      expect(plist).toContain("<string>--interval-ms</string>");
      expect(plist).toContain("<true/>");
      expect(plist).toContain("<key>SuccessfulExit</key>");
      expect(plist).toContain("<false/>");
      expect(plist).toContain("daemon.log</string>");
      expect(plist).toContain("<string>--auto-update</string>");
    });

    it("includes all flags when set", () => {
      const plist = generateLaunchdPlist(
        { interval: "60", quiet: true, bell: true, notify: true },
        execInfo,
      );
      expect(plist).toContain("<string>--quiet</string>");
      expect(plist).toContain("<string>--bell</string>");
      expect(plist).toContain("<string>--notify</string>");
      expect(plist).toContain(`<string>${60 * 60 * 1000}</string>`);
    });

    it("includes --smart-schedule off when disabled", () => {
      const plist = generateLaunchdPlist({ smartSchedule: false }, execInfo);
      expect(plist).toContain("<string>--smart-schedule</string>");
      expect(plist).toContain("<string>off</string>");
    });

    it("includes CC_PING_CONFIG when configDir is provided", () => {
      const plist = generateLaunchdPlist({}, execInfo, "/custom/config");
      expect(plist).toContain("<key>EnvironmentVariables</key>");
      expect(plist).toContain("<key>CC_PING_CONFIG</key>");
      expect(plist).toContain("<string>/custom/config</string>");
    });

    it("omits CC_PING_CONFIG when configDir is not provided", () => {
      const plist = generateLaunchdPlist({}, execInfo);
      expect(plist).not.toContain("CC_PING_CONFIG");
    });

    it("includes CC_PING_BIN when executable is a direct path", () => {
      const plist = generateLaunchdPlist({}, execInfo);
      expect(plist).toContain("CC_PING_BIN");
      expect(plist).toContain("/usr/local/bin/cc-ping");
    });

    it("omits CC_PING_BIN when executable uses node fallback", () => {
      const fallbackInfo: ExecInfo = {
        executable: "/usr/bin/node",
        args: ["/usr/local/lib/cli.js"],
      };
      const plist = generateLaunchdPlist({}, fallbackInfo);
      expect(plist).not.toContain("CC_PING_BIN");
    });

    it("uses fallback executable with args", () => {
      const fallback: ExecInfo = {
        executable: "/usr/bin/node",
        args: ["/usr/local/lib/cli.js"],
      };
      const plist = generateLaunchdPlist({}, fallback);
      expect(plist).toContain("<string>/usr/bin/node</string>");
      expect(plist).toContain("<string>/usr/local/lib/cli.js</string>");
    });

    it("escapes XML special characters", () => {
      const info: ExecInfo = {
        executable: "/path/with<special>&chars",
        args: [],
      };
      const plist = generateLaunchdPlist({}, info);
      expect(plist).toContain("&lt;special&gt;&amp;chars");
    });

    it("uses default interval when interval is invalid", () => {
      const plist = generateLaunchdPlist({ interval: "notanumber" }, execInfo);
      // Default is 5h = 18000000ms
      expect(plist).toContain("<string>18000000</string>");
    });

    it("uses log path from configDir when provided", () => {
      const plist = generateLaunchdPlist({}, execInfo, "/my/config");
      expect(plist).toContain("/my/config/daemon.log");
    });
  });

  describe("generateSystemdUnit", () => {
    const execInfo: ExecInfo = {
      executable: "/usr/local/bin/cc-ping",
      args: [],
    };

    it("generates valid unit with defaults", () => {
      const unit = generateSystemdUnit({}, execInfo);
      expect(unit).toContain("[Unit]");
      expect(unit).toContain("[Service]");
      expect(unit).toContain("[Install]");
      expect(unit).toContain("Type=simple");
      expect(unit).toContain("Restart=on-failure");
      expect(unit).toContain("RestartSec=10");
      expect(unit).toContain("WantedBy=default.target");
      expect(unit).toContain(
        "ExecStart=/usr/local/bin/cc-ping daemon _run --interval-ms",
      );
      expect(unit).toContain("--auto-update");
    });

    it("includes all flags when set", () => {
      const unit = generateSystemdUnit(
        { interval: "60", quiet: true, bell: true, notify: true },
        execInfo,
      );
      expect(unit).toContain("--quiet");
      expect(unit).toContain("--bell");
      expect(unit).toContain("--notify");
      expect(unit).toContain(`--interval-ms ${60 * 60 * 1000}`);
    });

    it("includes --smart-schedule off when disabled", () => {
      const unit = generateSystemdUnit({ smartSchedule: false }, execInfo);
      expect(unit).toContain("--smart-schedule off");
    });

    it("includes Environment when configDir is provided", () => {
      const unit = generateSystemdUnit({}, execInfo, "/custom/config");
      expect(unit).toContain("Environment=CC_PING_CONFIG=/custom/config");
    });

    it("omits CC_PING_CONFIG when configDir is not provided", () => {
      const unit = generateSystemdUnit({}, execInfo);
      expect(unit).not.toContain("CC_PING_CONFIG");
    });

    it("includes CC_PING_BIN when executable is a direct path", () => {
      const unit = generateSystemdUnit({}, execInfo);
      expect(unit).toContain("Environment=CC_PING_BIN=/usr/local/bin/cc-ping");
    });

    it("omits CC_PING_BIN when executable uses node fallback", () => {
      const fallbackInfo: ExecInfo = {
        executable: "/usr/bin/node",
        args: ["/usr/local/lib/cli.js"],
      };
      const unit = generateSystemdUnit({}, fallbackInfo);
      expect(unit).not.toContain("CC_PING_BIN");
    });

    it("quotes args with spaces", () => {
      const info: ExecInfo = {
        executable: "/path/to/node",
        args: ["/path with spaces/cli.js"],
      };
      const unit = generateSystemdUnit({}, info);
      expect(unit).toContain('"/path with spaces/cli.js"');
    });

    it("uses default interval when interval is invalid", () => {
      const unit = generateSystemdUnit({ interval: "bad" }, execInfo);
      expect(unit).toContain("--interval-ms 18000000");
    });
  });

  describe("servicePath", () => {
    it("returns launchd plist path on darwin", () => {
      const path = servicePath("darwin", "/Users/test");
      expect(path).toBe(
        "/Users/test/Library/LaunchAgents/com.cc-ping.daemon.plist",
      );
    });

    it("returns systemd unit path on linux", () => {
      const path = servicePath("linux", "/home/test");
      expect(path).toBe(
        "/home/test/.config/systemd/user/cc-ping-daemon.service",
      );
    });

    it("throws for unsupported platform", () => {
      expect(() => servicePath("win32", "C:\\Users\\test")).toThrow(
        "Unsupported platform: win32",
      );
    });

    it("throws for unknown platform", () => {
      expect(() => servicePath("freebsd", "/home/test")).toThrow(
        "Unsupported platform: freebsd",
      );
    });
  });

  describe("installService", () => {
    it("returns error for unsupported platform", async () => {
      const deps = makeDeps({ platform: "win32" });
      const result = await installService({}, deps);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unsupported platform");
    });

    it("returns error if service already installed", async () => {
      const deps = makeDeps({ existsSync: () => true });
      const result = await installService({}, deps);
      expect(result.success).toBe(false);
      expect(result.error).toContain("already installed");
      expect(result.error).toContain("daemon uninstall");
    });

    it("stops running daemon before installing", async () => {
      const stopDaemon = vi.fn().mockResolvedValue({ success: true });
      const deps = makeDeps({ stopDaemon });
      await installService({}, deps);
      expect(stopDaemon).toHaveBeenCalled();
    });

    it("ignores stopDaemon errors", async () => {
      const stopDaemon = vi.fn().mockRejectedValue(new Error("not running"));
      const deps = makeDeps({ stopDaemon });
      const result = await installService({}, deps);
      expect(result.success).toBe(true);
    });

    it("writes plist and loads on darwin", async () => {
      const writeFileSync = vi.fn();
      const mkdirSync = vi.fn();
      const execSync = vi.fn().mockReturnValue("/usr/local/bin/cc-ping\n");
      const deps = makeDeps({
        platform: "darwin",
        writeFileSync,
        mkdirSync,
        execSync,
      });

      const result = await installService({ interval: "60" }, deps);

      expect(result.success).toBe(true);
      expect(result.servicePath).toContain("LaunchAgents");
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining("LaunchAgents"),
        expect.stringContaining("com.cc-ping.daemon"),
      );
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining("launchctl load"),
      );
    });

    it("writes unit and enables on linux", async () => {
      const writeFileSync = vi.fn();
      const mkdirSync = vi.fn();
      const execSync = vi.fn().mockReturnValue("/usr/local/bin/cc-ping\n");
      const deps = makeDeps({
        platform: "linux",
        writeFileSync,
        mkdirSync,
        execSync,
      });

      const result = await installService({}, deps);

      expect(result.success).toBe(true);
      expect(result.servicePath).toContain("systemd");
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining("systemd"),
        expect.stringContaining("[Unit]"),
      );
      expect(execSync).toHaveBeenCalledWith("systemctl --user daemon-reload");
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining("systemctl --user enable --now"),
      );
    });

    it("returns error when launchctl load fails", async () => {
      const execSync = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes("launchctl")) throw new Error("load failed");
        return "/usr/local/bin/cc-ping\n";
      });
      const deps = makeDeps({ execSync });

      const result = await installService({}, deps);
      expect(result.success).toBe(false);
      expect(result.error).toContain("failed to load");
      expect(result.servicePath).toBeTruthy();
    });

    it("returns error when systemctl fails", async () => {
      const execSync = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes("systemctl")) throw new Error("systemctl failed");
        return "/usr/local/bin/cc-ping\n";
      });
      const deps = makeDeps({ platform: "linux", execSync });

      const result = await installService({}, deps);
      expect(result.success).toBe(false);
      expect(result.error).toContain("failed to load");
    });

    it("passes configDir override to generated service file", async () => {
      const writeFileSync = vi.fn();
      const deps = makeDeps({
        writeFileSync,
        configDir: "/custom/dir",
        execSync: vi.fn().mockReturnValue("/usr/local/bin/cc-ping\n"),
      });

      await installService({}, deps);

      const writtenContent = writeFileSync.mock.calls[0][1] as string;
      expect(writtenContent).toContain("CC_PING_CONFIG");
      expect(writtenContent).toContain("/custom/dir");
    });

    it("creates parent directory for service file", async () => {
      const mkdirSync = vi.fn();
      const deps = makeDeps({
        mkdirSync,
        execSync: vi.fn().mockReturnValue("/usr/local/bin/cc-ping\n"),
      });

      await installService({}, deps);

      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("LaunchAgents"),
        { recursive: true },
      );
    });

    it("passes all options to service file content", async () => {
      const writeFileSync = vi.fn();
      const deps = makeDeps({
        writeFileSync,
        execSync: vi.fn().mockReturnValue("/usr/local/bin/cc-ping\n"),
      });

      await installService(
        { interval: "120", quiet: true, bell: true, notify: true },
        deps,
      );

      const content = writeFileSync.mock.calls[0][1] as string;
      expect(content).toContain("--quiet");
      expect(content).toContain("--bell");
      expect(content).toContain("--notify");
    });
  });

  describe("uninstallService", () => {
    it("returns error for unsupported platform", async () => {
      const deps = makeDeps({ platform: "win32" });
      const result = await uninstallService(deps);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unsupported platform");
    });

    it("returns error when no service installed", async () => {
      const deps = makeDeps({ existsSync: () => false });
      const result = await uninstallService(deps);
      expect(result.success).toBe(false);
      expect(result.error).toBe("No service installed.");
    });

    it("unloads and removes plist on darwin", async () => {
      const unlinkSync = vi.fn();
      const execSync = vi.fn().mockReturnValue("");
      const deps = makeDeps({
        platform: "darwin",
        existsSync: () => true,
        unlinkSync,
        execSync,
      });

      const result = await uninstallService(deps);

      expect(result.success).toBe(true);
      expect(result.servicePath).toContain("LaunchAgents");
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining("launchctl unload"),
      );
      expect(unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining("LaunchAgents"),
      );
    });

    it("disables and removes unit on linux", async () => {
      const unlinkSync = vi.fn();
      const execSync = vi.fn().mockReturnValue("");
      const deps = makeDeps({
        platform: "linux",
        existsSync: () => true,
        unlinkSync,
        execSync,
      });

      const result = await uninstallService(deps);

      expect(result.success).toBe(true);
      expect(result.servicePath).toContain("systemd");
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining("systemctl --user disable --now"),
      );
      expect(unlinkSync).toHaveBeenCalled();
    });

    it("continues removal if unload fails", async () => {
      const unlinkSync = vi.fn();
      const execSync = vi.fn().mockImplementation(() => {
        throw new Error("already unloaded");
      });
      const deps = makeDeps({
        existsSync: () => true,
        unlinkSync,
        execSync,
      });

      const result = await uninstallService(deps);

      expect(result.success).toBe(true);
      expect(unlinkSync).toHaveBeenCalled();
    });
  });

  describe("installService service file content", () => {
    it("uses cc-ping as executable when which succeeds (no 'node' in plist)", async () => {
      const writeFileSync = vi.fn();
      const deps = makeDeps({
        platform: "darwin",
        writeFileSync,
        execSync: vi.fn().mockReturnValue("/usr/local/bin/cc-ping\n"),
      });

      await installService({ interval: "300" }, deps);

      const content = writeFileSync.mock.calls[0][1] as string;
      expect(content).toContain("<string>/usr/local/bin/cc-ping</string>");
      expect(content).not.toContain("node");
    });

    it("falls back to node + script when which fails", async () => {
      const writeFileSync = vi.fn();
      const execSync = vi.fn().mockImplementation((cmd: string) => {
        if (cmd === "which cc-ping") throw new Error("not found");
        return "";
      });
      const deps = makeDeps({
        platform: "darwin",
        writeFileSync,
        execSync,
      });

      await installService({}, deps);

      const content = writeFileSync.mock.calls[0][1] as string;
      expect(content).toContain(`<string>${process.execPath}</string>`);
      expect(content).toContain(`<string>${process.argv[1]}</string>`);
    });

    it("linux unit uses cc-ping directly when which succeeds", async () => {
      const writeFileSync = vi.fn();
      const deps = makeDeps({
        platform: "linux",
        writeFileSync,
        execSync: vi.fn().mockReturnValue("/usr/local/bin/cc-ping\n"),
      });

      await installService({ interval: "60", notify: true }, deps);

      const content = writeFileSync.mock.calls[0][1] as string;
      expect(content).toContain("ExecStart=/usr/local/bin/cc-ping daemon _run");
      expect(content).not.toContain("node");
    });

    it("linux unit falls back to node + script when which fails", async () => {
      const writeFileSync = vi.fn();
      const execSync = vi.fn().mockImplementation((cmd: string) => {
        if (cmd === "which cc-ping") throw new Error("not found");
        return "";
      });
      const deps = makeDeps({
        platform: "linux",
        writeFileSync,
        execSync,
      });

      await installService({}, deps);

      const content = writeFileSync.mock.calls[0][1] as string;
      expect(content).toContain(`ExecStart=${process.execPath}`);
    });
  });

  describe("getServiceStatus", () => {
    it("returns installed:true when service file exists on darwin", () => {
      const deps = makeDeps({
        platform: "darwin",
        existsSync: () => true,
      });

      const status = getServiceStatus(deps);

      expect(status.installed).toBe(true);
      expect(status.servicePath).toContain("LaunchAgents");
      expect(status.platform).toBe("darwin");
    });

    it("returns installed:false when no service file on darwin", () => {
      const deps = makeDeps({
        platform: "darwin",
        existsSync: () => false,
      });

      const status = getServiceStatus(deps);

      expect(status.installed).toBe(false);
      expect(status.servicePath).toContain("LaunchAgents");
      expect(status.platform).toBe("darwin");
    });

    it("returns installed:true when service file exists on linux", () => {
      const deps = makeDeps({
        platform: "linux",
        existsSync: () => true,
      });

      const status = getServiceStatus(deps);

      expect(status.installed).toBe(true);
      expect(status.servicePath).toContain("systemd");
      expect(status.platform).toBe("linux");
    });

    it("returns installed:false for unsupported platform", () => {
      const deps = makeDeps({ platform: "win32" });
      const status = getServiceStatus(deps);
      expect(status.installed).toBe(false);
      expect(status.platform).toBe("win32");
      expect(status.servicePath).toBeUndefined();
    });
  });
});
