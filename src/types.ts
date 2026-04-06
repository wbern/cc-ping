export interface AccountConfig {
  handle: string;
  configDir: string;
}

export interface PingResult {
  handle: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface Config {
  accounts: AccountConfig[];
}

export interface PingState {
  lastPing: Record<string, string>; // handle -> ISO 8601 timestamp
}
