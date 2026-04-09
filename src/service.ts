import { execSync as nodeExecSync } from "node:child_process";
import {
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  unlinkSync as nodeUnlinkSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { homedir as nodeHomedir } from "node:os";
import { dirname, join } from "node:path";

// --- Types ---

interface ServiceOptions {
  interval?: string;
  quiet?: boolean;
  bell?: boolean;
  notify?: boolean;
  smartSchedule?: boolean;
}

export interface ExecInfo {
  executable: string;
  args: string[];
}

interface ServiceStatus {
  installed: boolean;
  servicePath?: string;
  platform: string;
}

// --- Dependencies ---

export interface ServiceDeps {
  platform: string;
  homedir: () => string;
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, content: string) => void;
  unlinkSync: (path: string) => void;
  execSync: (cmd: string, options?: object) => string;
  stopDaemon: () => Promise<{ success: boolean; error?: string }>;
  configDir?: string;
}

// --- Pure functions ---

const PLIST_LABEL = "com.cc-ping.daemon";
const SYSTEMD_SERVICE = "cc-ping-daemon";

export function resolveExecutable(deps: {
  execSync: (cmd: string, options?: object) => string;
}): ExecInfo {
  try {
    const path = deps
      .execSync("which cc-ping", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      .trim();
    if (path) {
      return { executable: path, args: [] };
    }
  } catch {
    // which failed, fall back
  }
  return {
    executable: process.execPath,
    args: [process.argv[1]],
  };
}

export function generateLaunchdPlist(
  options: ServiceOptions,
  execInfo: ExecInfo,
  configDir?: string,
): string {
  const intervalMs = parseIntervalForService(options.interval);
  const programArgs = [
    ...execInfo.args,
    "daemon",
    "_run",
    "--interval-ms",
    String(intervalMs),
  ];
  if (options.quiet) programArgs.push("--quiet");
  if (options.bell) programArgs.push("--bell");
  if (options.notify) programArgs.push("--notify");
  if (options.smartSchedule === false)
    programArgs.push("--smart-schedule", "off");

  const allArgs = [execInfo.executable, ...programArgs];
  const argsXml = allArgs
    .map((a) => `      <string>${escapeXml(a)}</string>`)
    .join("\n");

  const logPath = join(
    configDir || join(nodeHomedir(), ".config", "cc-ping"),
    "daemon.log",
  );

  let envSection = "";
  if (configDir) {
    envSection = `
    <key>EnvironmentVariables</key>
    <dict>
      <key>CC_PING_CONFIG</key>
      <string>${escapeXml(configDir)}</string>
    </dict>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${escapeXml(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logPath)}</string>${envSection}
</dict>
</plist>
`;
}

export function generateSystemdUnit(
  options: ServiceOptions,
  execInfo: ExecInfo,
  configDir?: string,
): string {
  const intervalMs = parseIntervalForService(options.interval);
  const programArgs = [
    ...execInfo.args,
    "daemon",
    "_run",
    "--interval-ms",
    String(intervalMs),
  ];
  if (options.quiet) programArgs.push("--quiet");
  if (options.bell) programArgs.push("--bell");
  if (options.notify) programArgs.push("--notify");
  if (options.smartSchedule === false)
    programArgs.push("--smart-schedule", "off");

  const execStart = [execInfo.executable, ...programArgs]
    .map((a) => (a.includes(" ") ? `"${a}"` : a))
    .join(" ");

  let envLine = "";
  if (configDir) {
    envLine = `\nEnvironment=CC_PING_CONFIG=${configDir}`;
  }

  return `[Unit]
Description=cc-ping daemon - auto-ping Claude Code sessions

[Service]
Type=simple
ExecStart=${execStart}${envLine}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

export function servicePath(platform: string, home: string): string {
  switch (platform) {
    case "darwin":
      return join(home, "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
    case "linux":
      return join(
        home,
        ".config",
        "systemd",
        "user",
        `${SYSTEMD_SERVICE}.service`,
      );
    default:
      throw new Error(
        `Unsupported platform: ${platform}. Only macOS and Linux are supported.`,
      );
  }
}

// --- Orchestration functions ---

export async function installService(
  options: ServiceOptions,
  deps?: Partial<ServiceDeps>,
): Promise<{ success: boolean; servicePath: string; error?: string }> {
  /* c8 ignore next 8 -- production defaults */
  const _platform = deps?.platform ?? process.platform;
  const _homedir = deps?.homedir ?? nodeHomedir;
  const _existsSync = deps?.existsSync ?? nodeExistsSync;
  const _mkdirSync = deps?.mkdirSync ?? nodeMkdirSync;
  const _writeFileSync = deps?.writeFileSync ?? nodeWriteFileSync;
  const _execSync =
    deps?.execSync ??
    ((cmd: string) => nodeExecSync(cmd, { encoding: "utf-8" }));
  /* c8 ignore next 6 -- production default */
  const _stopDaemon =
    deps?.stopDaemon ??
    (async () => {
      const { stopDaemon } = await import("./daemon.js");
      return stopDaemon();
    });
  const _configDir = deps?.configDir;

  const home = _homedir();
  let path: string;
  try {
    path = servicePath(_platform, home);
  } catch (err) {
    return {
      success: false,
      servicePath: "",
      error: (err as Error).message,
    };
  }

  if (_existsSync(path)) {
    return {
      success: false,
      servicePath: path,
      error: `Service already installed at ${path}. Run \`daemon uninstall\` first.`,
    };
  }

  // Stop any running daemon (ignore errors)
  try {
    await _stopDaemon();
  } catch {
    // not running, that's fine
  }

  const execInfo = resolveExecutable({
    execSync: _execSync,
  });
  const configDir = _configDir || undefined;

  let content: string;
  if (_platform === "darwin") {
    content = generateLaunchdPlist(options, execInfo, configDir);
  } else {
    content = generateSystemdUnit(options, execInfo, configDir);
  }

  _mkdirSync(dirname(path), { recursive: true });
  _writeFileSync(path, content);

  try {
    if (_platform === "darwin") {
      _execSync(`launchctl load ${path}`);
    } else {
      _execSync("systemctl --user daemon-reload");
      _execSync(`systemctl --user enable --now ${SYSTEMD_SERVICE}`);
    }
  } catch (err) {
    return {
      success: false,
      servicePath: path,
      error: `Service file written but failed to load: ${(err as Error).message}`,
    };
  }

  return { success: true, servicePath: path };
}

export async function uninstallService(
  deps?: Partial<ServiceDeps>,
): Promise<{ success: boolean; servicePath?: string; error?: string }> {
  /* c8 ignore next 8 -- production defaults */
  const _platform = deps?.platform ?? process.platform;
  const _homedir = deps?.homedir ?? nodeHomedir;
  const _existsSync = deps?.existsSync ?? nodeExistsSync;
  const _unlinkSync = deps?.unlinkSync ?? nodeUnlinkSync;
  const _execSync =
    deps?.execSync ??
    ((cmd: string) => nodeExecSync(cmd, { encoding: "utf-8" }));

  const home = _homedir();
  let path: string;
  try {
    path = servicePath(_platform, home);
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message,
    };
  }

  if (!_existsSync(path)) {
    return {
      success: false,
      servicePath: path,
      error: "No service installed.",
    };
  }

  try {
    if (_platform === "darwin") {
      _execSync(`launchctl unload ${path}`);
    } else {
      _execSync(`systemctl --user disable --now ${SYSTEMD_SERVICE}`);
    }
  } catch {
    // Unload may fail if already unloaded, continue to remove file
  }

  _unlinkSync(path);

  return { success: true, servicePath: path };
}

export function getServiceStatus(deps?: Partial<ServiceDeps>): ServiceStatus {
  /* c8 ignore next 3 -- production defaults */
  const _platform = deps?.platform ?? process.platform;
  const _homedir = deps?.homedir ?? nodeHomedir;
  const _existsSync = deps?.existsSync ?? nodeExistsSync;

  const home = _homedir();
  let path: string;
  try {
    path = servicePath(_platform, home);
  } catch {
    return { installed: false, platform: _platform };
  }

  return {
    installed: _existsSync(path),
    servicePath: path,
    platform: _platform,
  };
}

// --- Helpers ---

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const QUOTA_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours

function parseIntervalForService(value: string | undefined): number {
  if (!value) return QUOTA_WINDOW_MS;
  const minutes = Number(value);
  if (Number.isNaN(minutes) || minutes <= 0) return QUOTA_WINDOW_MS;
  return minutes * 60 * 1000;
}
