export interface AccountConfig {
  handle: string;
  configDir: string;
  group?: string;
  scheduleResetAt?: string;
}

export interface ClaudeJsonResponse {
  type: string;
  subtype: string;
  session_id: string;
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  api_error_status?: number;
  num_turns: number;
  result: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  model: string;
}

export interface PingMeta {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  sessionId: string;
}

export interface PingResult {
  handle: string;
  success: boolean;
  durationMs: number;
  failureReason?: PingFailureReason;
  error?: string;
  claudeResponse?: ClaudeJsonResponse;
  // When the failure was a rate limit (HTTP 429) and the body named a reset
  // time, the absolute instant that limit lifts (host-local). Drives the
  // daemon's sleep-until-reset scheduling.
  rateLimitResetAt?: Date;
}

export type PingFailureReason =
  | "expect_missing"
  | "claude_missing"
  | "claude_spawn_failed"
  | "not_authenticated"
  | "startup_prompt_timeout"
  | "input_failed"
  | "response_timeout"
  | "session_exit_failed"
  | "interactive_failed"
  | "legacy_command_failed"
  | "legacy_json_parse_failed"
  | "legacy_claude_error"
  | "rate_limited";

export type PingMode = "print" | "experimental-interactive";
export type PromptStyle = "mixed" | "math" | "trivia" | "tiny-chat" | "chess";

export interface Settings {
  pingMode?: PingMode | "legacy-print" | "interactive";
  interactiveExitDelayMs?: number;
  interactiveReadyPattern?: string;
  interactiveReadyFallbackDelayMs?: number;
  promptStyle?: PromptStyle;
  model?: string;
}

export type RemoteNotifyEvent = "failure" | "new-window" | "rate-limited";

export interface RemoteNotifyConfig {
  url: string;
  events?: RemoteNotifyEvent[];
}

export interface Config {
  accounts: AccountConfig[];
  settings?: Settings;
  remoteNotify?: RemoteNotifyConfig;
  notifyCommand?: string[];
}

export interface AccountIdentity {
  accountUuid: string;
  email: string;
}

export interface PingState {
  lastPing: Record<string, string>; // handle -> ISO 8601 timestamp
  lastPingMeta?: Record<string, PingMeta>;
  needsLogin?: Record<string, string>; // handle -> ISO 8601 timestamp of first 401
  accountTiming?: Record<string, AccountTiming>;
}

export type TimingSource =
  | "estimated"
  | "parsed_rate_limit"
  | "manual_override";
export type TimingConfidence = "low" | "medium" | "high";

export interface AccountTiming {
  sessionResetAt: string;
  source: TimingSource;
  confidence: TimingConfidence;
  updatedAt: string;
  reason?: string;
}

export interface DaemonState {
  pid: number;
  startedAt: string; // ISO 8601
  intervalMs: number;
  configDir: string;
  lastPingAt?: string; // ISO 8601
  version?: string;
}
