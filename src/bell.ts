export function ringBell(write?: (s: string) => void): void {
  const w = write ?? ((s: string) => process.stdout.write(s));
  w("\x07");
}
