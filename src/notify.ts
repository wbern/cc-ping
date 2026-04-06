import { execFile as defaultExecFile } from "node:child_process";

type ExecFn = (
  cmd: string,
  args: string[],
  cb: (error: Error | null) => void,
) => void;

export function buildNotifyCommand(
  title: string,
  body: string,
  platform: string,
): [string, string[]] | null {
  switch (platform) {
    case "darwin":
      return [
        "osascript",
        ["-e", `display notification "${body}" with title "${title}"`],
      ];
    case "linux":
      return ["notify-send", [title, body]];
    case "win32":
      return [
        "powershell",
        [
          "-Command",
          `[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(5000, '${title}', '${body}', 'Error'); Start-Sleep -Seconds 6; $n.Dispose()`,
        ],
      ];
    default:
      return null;
  }
}

export function sendNotification(
  title: string,
  body: string,
  platform: string = process.platform,
  exec: ExecFn = defaultExecFile,
): Promise<boolean> {
  const cmd = buildNotifyCommand(title, body, platform);
  if (!cmd) return Promise.resolve(false);

  return new Promise((resolve) => {
    exec(cmd[0], cmd[1], (error) => {
      resolve(!error);
    });
  });
}
