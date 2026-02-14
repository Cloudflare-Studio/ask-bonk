// Structured logging utility following wide event / canonical log line principles.
// Outputs JSON to console for easy querying in Cloudflare Workers logs.
//
// Usage:
//   const log = createLogger({ service: 'bonk', owner: 'foo', repo: 'bar' });
//   log.info('webhook_received', { event_type: 'issue_comment', actor: 'user' });
//   log.error('token_exchange_failed', { error: 'Invalid OIDC token' });
//
// All logs include: timestamp, level, event, service, and any context fields.

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  service?: string;
  request_id?: string;
  owner?: string;
  repo?: string;
  issue_number?: number;
  run_id?: number;
  ask_id?: string;
  session_id?: string;
  actor?: string;
  installation_id?: number;
  [key: string]: unknown;
}

interface LogEntry extends LogContext {
  timestamp: string;
  level: LogLevel;
  event: string;
}

// Redacts credentials from URLs to prevent token leakage in logs.
// Matches patterns like: https://x-access-token:ghp_xxx@github.com/...
// Also handles edge case of empty username: https://:token@host
export function sanitizeSecrets(text: string): string {
  return text.replace(/(https?:\/\/[^:]*:)[^@]+(@)/gi, "$1[REDACTED]$2");
}

function formatError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      error_type: err.name,
      error_message: sanitizeSecrets(err.message),
      error_stack: err.stack?.split("\n").slice(0, 10).join("\n"),
    };
  }
  return { error_message: sanitizeSecrets(String(err)) };
}

function emit(
  level: LogLevel,
  event: string,
  context: LogContext,
  data: Record<string, unknown> = {},
): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...context,
    ...data,
  };

  // Use the appropriate console method for log level.
  // Cloudflare Workers logs capture these as structured data when output as JSON.
  const json = JSON.stringify(entry);
  switch (level) {
    case "debug":
      console.debug(json);
      break;
    case "info":
      console.info(json);
      break;
    case "warn":
      console.warn(json);
      break;
    case "error":
      console.error(json);
      break;
  }
}

export interface Logger {
  debug: (event: string, data?: Record<string, unknown>) => void;
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
  error: (event: string, data?: Record<string, unknown>) => void;
  /** Log an error with automatic error object formatting */
  errorWithException: (event: string, err: unknown, data?: Record<string, unknown>) => void;
  /** Create a child logger with additional context */
  child: (additionalContext: LogContext) => Logger;
}

export function createLogger(context: LogContext = {}): Logger {
  const baseContext: LogContext = { service: "bonk", ...context };

  return {
    debug: (event, data = {}) => emit("debug", event, baseContext, data),
    info: (event, data = {}) => emit("info", event, baseContext, data),
    warn: (event, data = {}) => emit("warn", event, baseContext, data),
    error: (event, data = {}) => emit("error", event, baseContext, data),
    errorWithException: (event, err, data = {}) =>
      emit("error", event, baseContext, { ...data, ...formatError(err) }),
    child: (additionalContext) => createLogger({ ...baseContext, ...additionalContext }),
  };
}

// Default logger for cases where no context is available
export const log = createLogger();
