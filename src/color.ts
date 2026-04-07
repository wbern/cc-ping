function isColorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR === "1") return true;
  if (process.env.FORCE_COLOR === "0") return false;
  return process.stdout.isTTY ?? false;
}

function wrap(code: string, text: string): string {
  return isColorEnabled() ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const green = (text: string): string => wrap("32", text);
export const red = (text: string): string => wrap("31", text);
export const yellow = (text: string): string => wrap("33", text);
