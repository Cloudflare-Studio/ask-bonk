import { RequestError } from "@octokit/request-error";

// Retry configuration for transient failures (network issues, rate limits).
// 3 attempts total with exponential backoff starting at 5 seconds.
// Client errors (4xx) are not retried - they won't succeed.
export const RETRY_CONFIG = {
  times: 3,
  delayMs: 2000, // Reduced from 5s to 2s for faster feedback
  backoff: "exponential" as const,
  shouldRetry: (err: unknown) => {
    // Only retry 5xx or specific transient errors
    if (err instanceof RequestError) {
      return err.status >= 500 || err.status === 429;
    }
    // If it's a network error (no status), retry.
    // If it's a local error (like key validation), don't retry.
    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    const isLikelyLocal = msg.includes("key") || msg.includes("format") || msg.includes("invalid") || msg.includes("auth");
    return !isLikelyLocal;
  },
  onRetry: (err: unknown, attempt: number) => {
    console.log(`[Setup] Retrying getInstallationId (attempt ${attempt}) due to: ${err instanceof Error ? err.message : String(err)}`);
  }
} as const;

// Installation ID cache TTL (30 minutes)
export const APP_INSTALLATION_CACHE_TTL_SECS = 1800;

// Durable Object polling interval for workflow status (5 minutes)
export const WORKFLOW_POLL_INTERVAL_SECS = 300;

// Maximum time to track a workflow run before the polling safety net declares
// a timeout (6 hours — the GitHub Actions workflow-level maximum). Since job
// tracking is cheap, we default to the platform ceiling so the tracking window
// never expires before the workflow itself does.
//
// Override with the BONK_MAX_TRACK_SECS env var (value in seconds).
// You're unlikely to need to reduce this; set it higher only if you run
// workflows with custom timeouts exceeding 6 hours (self-hosted runners).
export const DEFAULT_MAX_WORKFLOW_TRACKING_MS = 6 * 60 * 60 * 1000;

// GitHub PR title max length
export const PR_TITLE_MAX_LENGTH = 256;

// Workflow run polling delays: [immediate, 10s, 20s, 30s]
// GitHub Actions takes time to queue runs after the triggering event.
export const WORKFLOW_RUN_POLL_DELAYS_MS = [0, 10_000, 20_000, 30_000] as const;
