import { RequestError } from "@octokit/request-error";

// Retry configuration for transient failures (network issues, rate limits).
// 3 attempts total with exponential backoff starting at 5 seconds.
// Client errors (4xx) are not retried - they won't succeed.
export const RETRY_CONFIG = {
  times: 3,
  delayMs: 5000,
  backoff: "exponential" as const,
  shouldRetry: (err: unknown) =>
    !(err instanceof RequestError && err.status >= 400 && err.status < 500),
} as const;

// Installation ID cache TTL (30 minutes)
export const APP_INSTALLATION_CACHE_TTL_SECS = 1800;

// Durable Object polling interval for workflow status (5 minutes)
export const WORKFLOW_POLL_INTERVAL_SECS = 300;

// Maximum time to track a workflow run before timing out (30 minutes)
export const MAX_WORKFLOW_TRACKING_MS = 30 * 60 * 1000;

// GitHub PR title max length
export const PR_TITLE_MAX_LENGTH = 256;

// Workflow run polling delays: [immediate, 10s, 20s, 30s]
// GitHub Actions takes time to queue runs after the triggering event.
export const WORKFLOW_RUN_POLL_DELAYS_MS = [0, 10_000, 20_000, 30_000] as const;
