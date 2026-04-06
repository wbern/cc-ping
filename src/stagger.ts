import { QUOTA_WINDOW_MS } from "./state.js";

export function calculateStagger(
  accountCount: number,
  windowMs: number = QUOTA_WINDOW_MS,
): number {
  if (accountCount <= 1) return 0;
  return Math.floor(windowMs / accountCount);
}

export function parseStagger(value: string, accountCount: number): number {
  if (value === "auto") {
    return calculateStagger(accountCount);
  }

  const minutes = Number(value);
  if (Number.isNaN(minutes)) {
    throw new Error(`Invalid stagger value: ${value}`);
  }
  if (minutes <= 0) {
    throw new Error("Stagger must be a positive number");
  }
  return minutes * 60 * 1000;
}
