import { execSync as nodeExecSync } from "node:child_process";
import {
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  unlinkSync as nodeUnlinkSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { homedir as nodeHomedir } from "node:os";
import { dirname, join } from "node:path";
import { selfArgs } from "./paths.js";

// --- Types ---

interface ServiceOptions {
  interval?: string;
  quiet?: boolean;
  bell?: boolean;
  notify?: boolean;
  smartSchedule?: boolean;
  deferStart?: boolean;
}

export interface ExecInfo {
  executable: string;
  args: string[];
}

interface ServiceStatus {
  installed: boolean;
  servicePath?: string;
  platform: string;
  loaded?: boolean;
  running?: boolean;
  watchdogInstalled?: boolean;
  watchdogLoaded?: boolean;
  watchdogActive?: boolean;
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
  envPath?: string;
}

// --- Pure functions ---

const PLIST_LABEL = "com.cc-ping.daemon";
const SYSTEMD_SERVICE = "cc-ping-daemon";
const WATCHDOG_PLIST_LABEL = "com.cc-ping.watchdog";
const WATCHDOG_SYSTEMD_UNIT = "cc-ping-watchdog";

// How often the external watchdog checks the daemon's heartbeat. Recovery
// latency is bounded by this plus the heartbeat staleness threshold.
const WATCHDOG_INTERVAL_SEC = 120;

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
  const [exe, ...prefix] = selfArgs();
  return { executable: exe, args: prefix };
}

export function generateLaunchdPlist(
  options: ServiceOptions,
  execInfo: ExecInfo,
  configDir?: string,
  path?: string,
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
  programArgs.push("--auto-update");

  const allArgs = [execInfo.executable, ...programArgs];
  const argsXml = allArgs
    .map((a) => `      <string>${escapeXml(a)}</string>`)
    .join("\n");

  const logPath = join(
    configDir || join(nodeHomedir(), ".config", "cc-ping"),
    "daemon.log",
  );

  const envVars: Record<string, string> = {};
  if (configDir) envVars.CC_PING_CONFIG = configDir;
  if (execInfo.args.length === 0) envVars.CC_PING_BIN = execInfo.executable;
  if (path) envVars.PATH = path;

  let envSection = "";
  if (Object.keys(envVars).length > 0) {
    const entries = Object.entries(envVars)
      .map(
        ([k, v]) =>
          `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`,
      )
      .join("\n");
    envSection = `
    <key>EnvironmentVariables</key>
    <dict>
${entries}
    </dict>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
${options.deferStart ? "    <key>Disabled</key>\n    <true/>\n" : ""}    <key>ProgramArguments</key>
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

export function generateWatchdogPlist(
  execInfo: ExecInfo,
  configDir?: string,
  path?: string,
  disabled = false,
): string {
  const allArgs = [
    execInfo.executable,
    ...execInfo.args,
    "daemon",
    "_healthcheck",
  ];
  const argsXml = allArgs
    .map((a) => `      <string>${escapeXml(a)}</string>`)
    .join("\n");

  const logPath = join(
    configDir || join(nodeHomedir(), ".config", "cc-ping"),
    "watchdog.log",
  );

  const envVars: Record<string, string> = {};
  if (configDir) envVars.CC_PING_CONFIG = configDir;
  if (execInfo.args.length === 0) envVars.CC_PING_BIN = execInfo.executable;
  if (path) envVars.PATH = path;

  let envSection = "";
  if (Object.keys(envVars).length > 0) {
    const entries = Object.entries(envVars)
      .map(
        ([k, v]) =>
          `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`,
      )
      .join("\n");
    envSection = `
    <key>EnvironmentVariables</key>
    <dict>
${entries}
    </dict>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${WATCHDOG_PLIST_LABEL}</string>
${disabled ? "    <key>Disabled</key>\n    <true/>\n" : ""}    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>StartInterval</key>
    <integer>${WATCHDOG_INTERVAL_SEC}</integer>
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
  path?: string,
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
  programArgs.push("--auto-update");

  const execStart = [execInfo.executable, ...programArgs]
    .map((a) => (a.includes(" ") ? `"${a}"` : a))
    .join(" ");

  const envPairs: string[] = [];
  if (configDir) envPairs.push(`CC_PING_CONFIG=${configDir}`);
  if (execInfo.args.length === 0)
    envPairs.push(`CC_PING_BIN=${execInfo.executable}`);
  if (path) envPairs.push(`PATH=${path}`);
  const envLine = envPairs.map((p) => `\nEnvironment=${p}`).join("");

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

export function generateWatchdogSystemd(
  execInfo: ExecInfo,
  configDir?: string,
  path?: string,
): { service: string; timer: string } {
  const execStart = [
    execInfo.executable,
    ...execInfo.args,
    "daemon",
    "_healthcheck",
  ]
    .map((a) => (a.includes(" ") ? `"${a}"` : a))
    .join(" ");

  const envPairs: string[] = [];
  if (configDir) envPairs.push(`CC_PING_CONFIG=${configDir}`);
  if (execInfo.args.length === 0)
    envPairs.push(`CC_PING_BIN=${execInfo.executable}`);
  if (path) envPairs.push(`PATH=${path}`);
  const envLine = envPairs.map((p) => `\nEnvironment=${p}`).join("");

  const service = `[Unit]
Description=cc-ping watchdog - recover a wedged daemon

[Service]
Type=oneshot
ExecStart=${execStart}${envLine}
`;

  const timer = `[Unit]
Description=cc-ping watchdog timer

[Timer]
OnBootSec=${WATCHDOG_INTERVAL_SEC}
OnUnitActiveSec=${WATCHDOG_INTERVAL_SEC}

[Install]
WantedBy=timers.target
`;

  return { service, timer };
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

// The path whose presence signals the watchdog is installed: the launchd agent
// on darwin, the systemd timer on linux. The linux .service unit lives beside
// the timer in the same directory.
export function watchdogServicePath(platform: string, home: string): string {
  switch (platform) {
    case "darwin":
      return join(
        home,
        "Library",
        "LaunchAgents",
        `${WATCHDOG_PLIST_LABEL}.plist`,
      );
    case "linux":
      return join(
        home,
        ".config",
        "systemd",
        "user",
        `${WATCHDOG_SYSTEMD_UNIT}.timer`,
      );
    default:
      throw new Error(
        `Unsupported platform: ${platform}. Only macOS and Linux are supported.`,
      );
  }
}

// Writes the watchdog unit file(s): one launchd plist on darwin, a oneshot
// service plus its timer on linux. Loading them is left to the caller, which
// differs between a fresh install and an in-place top-up.
function writeWatchdogUnits(
  writeFileSync: (path: string, content: string) => void,
  platform: string,
  watchdogPath: string,
  execInfo: ExecInfo,
  configDir: string | undefined,
  envPath: string | undefined,
  deferStart = false,
): void {
  if (platform === "darwin") {
    writeFileSync(
      watchdogPath,
      generateWatchdogPlist(execInfo, configDir, envPath, deferStart),
    );
  } else {
    const { service, timer } = generateWatchdogSystemd(
      execInfo,
      configDir,
      envPath,
    );
    writeFileSync(
      join(dirname(watchdogPath), `${WATCHDOG_SYSTEMD_UNIT}.service`),
      service,
    );
    writeFileSync(watchdogPath, timer);
  }
}

// --- Orchestration functions ---

export async function installService(
  options: ServiceOptions,
  deps?: Partial<ServiceDeps>,
): Promise<{
  success: boolean;
  servicePath: string;
  deferred?: boolean;
  activated?: boolean;
  watchdogInstalled?: boolean;
  watchdogActivated?: boolean;
  error?: string;
}> {
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

  const watchdogPath = watchdogServicePath(_platform, home);

  if (_existsSync(path)) {
    // The daemon is already installed. If the watchdog unit is missing — e.g.
    // upgrading from a version that predates it — add just the watchdog in
    // place. This leaves the daemon unit (and its flags) untouched, so an
    // upgrade is a single `daemon install` instead of uninstall-then-reinstall.
    if (_existsSync(watchdogPath)) {
      return {
        success: false,
        servicePath: path,
        error: `Service already installed at ${path}. Run \`daemon uninstall\` first.`,
      };
    }

    const execInfo = resolveExecutable({ execSync: _execSync });
    const configDir = _configDir || undefined;
    const envPath = deps?.envPath ?? process.env.PATH;
    // No mkdir needed: the watchdog unit is co-located with the daemon unit
    // (same LaunchAgents / systemd-user dir), and we only reach here because the
    // daemon unit exists — so its directory does too.
    writeWatchdogUnits(
      _writeFileSync,
      _platform,
      watchdogPath,
      execInfo,
      configDir,
      envPath,
    );

    if (options.deferStart) {
      return {
        success: true,
        servicePath: path,
        deferred: true,
        activated: false,
        watchdogInstalled: true,
        watchdogActivated: false,
      };
    }

    try {
      if (_platform === "darwin") {
        _execSync(`launchctl load "${watchdogPath}"`);
      } else {
        _execSync("systemctl --user daemon-reload");
        _execSync(
          `systemctl --user enable --now ${WATCHDOG_SYSTEMD_UNIT}.timer`,
        );
      }
    } catch (err) {
      return {
        success: false,
        servicePath: path,
        error: `Watchdog file written but failed to load: ${(err as Error).message}`,
      };
    }

    return {
      success: true,
      servicePath: path,
      activated: true,
      watchdogInstalled: true,
      watchdogActivated: true,
    };
  }

  if (!options.deferStart) {
    // Stop any running unmanaged daemon before handing control to the service
    // manager. Deferred installs are intentionally file-only.
    try {
      await _stopDaemon();
    } catch {
      // not running, that's fine
    }
  }

  const execInfo = resolveExecutable({
    execSync: _execSync,
  });
  const configDir = _configDir || undefined;

  const envPath = deps?.envPath ?? process.env.PATH;

  let content: string;
  if (_platform === "darwin") {
    content = generateLaunchdPlist(options, execInfo, configDir, envPath);
  } else {
    content = generateSystemdUnit(options, execInfo, configDir, envPath);
  }

  _mkdirSync(dirname(path), { recursive: true });
  _writeFileSync(path, content);

  // Watchdog units: a separate periodic check that recovers a wedged daemon.
  // Written after the main unit so callers inspecting the first write still see
  // the daemon service.
  writeWatchdogUnits(
    _writeFileSync,
    _platform,
    watchdogPath,
    execInfo,
    configDir,
    envPath,
    options.deferStart,
  );

  if (options.deferStart) {
    return {
      success: true,
      servicePath: path,
      deferred: true,
      activated: false,
      watchdogInstalled: true,
      watchdogActivated: false,
    };
  }

  try {
    if (_platform === "darwin") {
      _execSync(`launchctl load -w "${path}"`);
      _execSync(`launchctl load "${watchdogPath}"`);
    } else {
      _execSync("systemctl --user daemon-reload");
      _execSync(`systemctl --user enable --now ${SYSTEMD_SERVICE}`);
      _execSync(`systemctl --user enable --now ${WATCHDOG_SYSTEMD_UNIT}.timer`);
    }
  } catch (err) {
    return {
      success: false,
      servicePath: path,
      error: `Service file written but failed to load: ${(err as Error).message}`,
    };
  }

  return {
    success: true,
    servicePath: path,
    activated: true,
    watchdogInstalled: true,
    watchdogActivated: true,
  };
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
      _execSync(`launchctl unload "${path}"`);
    } else {
      _execSync(`systemctl --user disable --now ${SYSTEMD_SERVICE}`);
    }
  } catch {
    // Unload may fail if already unloaded, continue to remove file
  }

  _unlinkSync(path);

  // Remove the watchdog units too. Best-effort and existence-guarded: a daemon
  // installed before the watchdog existed won't have these files.
  const watchdogPath = watchdogServicePath(_platform, home);
  try {
    if (_platform === "darwin") {
      _execSync(`launchctl unload "${watchdogPath}"`);
    } else {
      _execSync(
        `systemctl --user disable --now ${WATCHDOG_SYSTEMD_UNIT}.timer`,
      );
    }
  } catch {
    // not loaded — fine
  }
  const watchdogFiles =
    _platform === "darwin"
      ? [watchdogPath]
      : [
          watchdogPath,
          join(dirname(watchdogPath), `${WATCHDOG_SYSTEMD_UNIT}.service`),
        ];
  for (const file of watchdogFiles) {
    if (_existsSync(file)) _unlinkSync(file);
  }

  return { success: true, servicePath: path };
}

// (Re)start the installed system service so it runs from its own definition
// (launchd plist / systemd unit) — preserving --notify and --auto-update, which
// a bare `daemon start` cannot. This also activates the watchdog if present,
// so a deferred install can be fully brought online later.
export function startService(deps?: Partial<ServiceDeps>): {
  success: boolean;
  error?: string;
};
export function startService(
  deps: Partial<ServiceDeps> | undefined,
  mode: "start" | "restart",
): {
  success: boolean;
  error?: string;
};
export function startService(
  deps?: Partial<ServiceDeps>,
  mode: "start" | "restart" = "start",
): {
  success: boolean;
  error?: string;
} {
  /* c8 ignore next 6 -- production defaults */
  const _platform = deps?.platform ?? process.platform;
  const _homedir = deps?.homedir ?? nodeHomedir;
  const _existsSync = deps?.existsSync ?? nodeExistsSync;
  const _execSync =
    deps?.execSync ??
    ((cmd: string) => nodeExecSync(cmd, { encoding: "utf-8" }));

  const home = _homedir();
  let path: string;
  try {
    path = servicePath(_platform, home);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
  const watchdogPath = watchdogServicePath(_platform, home);
  const hasWatchdog = _existsSync(watchdogPath);

  try {
    if (_platform === "darwin") {
      try {
        _execSync(`launchctl unload "${path}"`);
      } catch {
        // Not loaded yet — fine, the load below registers it.
      }
      _execSync(`launchctl load -w "${path}"`);
      if (hasWatchdog) {
        try {
          _execSync(`launchctl unload "${watchdogPath}"`);
        } catch {
          // Not loaded yet — fine.
        }
        _execSync(`launchctl load -w "${watchdogPath}"`);
      }
    } else {
      _execSync("systemctl --user daemon-reload");
      if (mode === "restart") {
        _execSync(`systemctl --user enable ${SYSTEMD_SERVICE}`);
        _execSync(`systemctl --user restart ${SYSTEMD_SERVICE}`);
      } else {
        _execSync(`systemctl --user enable --now ${SYSTEMD_SERVICE}`);
      }
      if (hasWatchdog) {
        _execSync(
          `systemctl --user enable --now ${WATCHDOG_SYSTEMD_UNIT}.timer`,
        );
      }
    }
  } catch (err) {
    return {
      success: false,
      error: `Failed to start service: ${(err as Error).message}`,
    };
  }

  return { success: true };
}

interface DaemonStartOptions {
  interval?: string;
  quiet?: boolean;
  bell?: boolean;
  notify?: boolean;
  smartSchedule?: boolean;
  version?: string;
}

interface StartOrRestartDeps extends Partial<ServiceDeps> {
  startDaemon?: (options: DaemonStartOptions) => {
    success: boolean;
    pid?: number;
    error?: string;
  };
}

// Bring the daemon up the right way. If a system service is installed, drive it
// through the service manager (startService) so it runs from the plist/unit with
// --notify and --auto-update; a bare spawn would silently drop those. Only when
// no service is installed do we spawn an unmanaged process. For "restart" of an
// unmanaged daemon we stop the old one first. Returns whether the result is
// service-managed so callers can report it.
export async function startOrRestartDaemon(
  mode: "start" | "restart",
  options: DaemonStartOptions,
  deps?: StartOrRestartDeps,
): Promise<{
  success: boolean;
  managed: boolean;
  pid?: number;
  error?: string;
}> {
  const status = getServiceStatus(deps);
  if (status.installed) {
    const result = startService(deps, mode);
    return { success: result.success, managed: true, error: result.error };
  }

  if (mode === "restart") {
    /* c8 ignore next 2 -- production default */
    const _stopDaemon =
      deps?.stopDaemon ?? (await import("./daemon.js")).stopDaemon;
    await _stopDaemon().catch(() => {});
  }

  /* c8 ignore next 2 -- production default */
  const _startDaemon =
    deps?.startDaemon ?? (await import("./daemon.js")).startDaemon;
  const result = _startDaemon(options);
  return {
    success: result.success,
    managed: false,
    pid: result.pid,
    error: result.error,
  };
}

export function getServiceStatus(deps?: Partial<ServiceDeps>): ServiceStatus {
  /* c8 ignore next 6 -- production defaults */
  const _platform = deps?.platform ?? process.platform;
  const _homedir = deps?.homedir ?? nodeHomedir;
  const _existsSync = deps?.existsSync ?? nodeExistsSync;
  const _execSync =
    deps?.execSync ??
    ((cmd: string) => nodeExecSync(cmd, { encoding: "utf-8" }));

  const home = _homedir();
  let path: string;
  try {
    path = servicePath(_platform, home);
  } catch {
    return { installed: false, platform: _platform };
  }

  const installed = _existsSync(path);
  const watchdogPath = watchdogServicePath(_platform, home);
  const watchdogInstalled = _existsSync(watchdogPath);
  const serviceRuntime = getManagerRuntimeStatus(
    _platform,
    PLIST_LABEL,
    SYSTEMD_SERVICE,
    _execSync,
  );
  const watchdogRuntime = getManagerRuntimeStatus(
    _platform,
    WATCHDOG_PLIST_LABEL,
    `${WATCHDOG_SYSTEMD_UNIT}.timer`,
    _execSync,
  );

  return {
    installed,
    servicePath: path,
    platform: _platform,
    loaded: installed ? serviceRuntime.loaded : false,
    running: installed ? serviceRuntime.running : false,
    watchdogInstalled,
    watchdogLoaded: watchdogInstalled ? watchdogRuntime.loaded : false,
    watchdogActive: watchdogInstalled
      ? getWatchdogActive(_platform, watchdogRuntime)
      : false,
  };
}

function getManagerRuntimeStatus(
  platform: string,
  launchdLabel: string,
  systemdUnit: string,
  execSync: (cmd: string, options?: object) => string,
): { loaded: boolean; running: boolean } {
  if (platform === "darwin") {
    return getLaunchdRuntimeStatus(launchdLabel, execSync);
  }
  return getSystemdRuntimeStatus(systemdUnit, execSync);
}

function getLaunchdRuntimeStatus(
  label: string,
  execSync: (cmd: string, options?: object) => string,
): { loaded: boolean; running: boolean } {
  try {
    const output = execSync("launchctl list", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = output.match(
      new RegExp(
        `(?:^|\\n)\\s*(\\S+)\\s+\\S+\\s+${escapeRegExp(label)}(?:\\s|$)`,
      ),
    );
    return {
      loaded: Boolean(match),
      running: Boolean(match && match[1] !== "-"),
    };
  } catch {
    return { loaded: false, running: false };
  }
}

function getSystemdRuntimeStatus(
  unit: string,
  execSync: (cmd: string, options?: object) => string,
): { loaded: boolean; running: boolean } {
  const running = runSystemctlCheck(execSync, `is-active ${unit}`, "active");
  const enabled = runSystemctlCheck(execSync, `is-enabled ${unit}`, "enabled");
  return { loaded: enabled || running, running };
}

function getWatchdogActive(
  platform: string,
  runtime: { loaded: boolean; running: boolean },
): boolean {
  return platform === "darwin" ? runtime.loaded : runtime.running;
}

function runSystemctlCheck(
  execSync: (cmd: string, options?: object) => string,
  args: string,
  expected: string,
): boolean {
  try {
    return (
      execSync(`systemctl --user ${args}`, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === expected
    );
  } catch {
    return false;
  }
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

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const QUOTA_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours

function parseIntervalForService(value: string | undefined): number {
  if (!value) return QUOTA_WINDOW_MS;
  const minutes = Number(value);
  if (Number.isNaN(minutes) || minutes <= 0) return QUOTA_WINDOW_MS;
  return minutes * 60 * 1000;
}
