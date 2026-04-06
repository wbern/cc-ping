export interface AccountConfig {
  handle: string;
  configDir: string;
}

export interface ClaudeJsonResponse {
  type: string;
  subtype: string;
  session_id: string;
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
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
  error?: string;
  claudeResponse?: ClaudeJsonResponse;
}

export interface Config {
  accounts: AccountConfig[];
}

export interface AccountIdentity {
  accountUuid: string;
  email: string;
}

export interface PingState {
  lastPing: Record<string, string>; // handle -> ISO 8601 timestamp
  lastPingMeta?: Record<string, PingMeta>;
}
