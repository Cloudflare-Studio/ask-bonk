const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

interface RetryOptions {
  timeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientStatus(response: Response): boolean {
  if (response.status >= 500 || response.status === 429) return true;
  if (response.status !== 403) return false;
  const retryAfter = response.headers.get("retry-after");
  const remaining = response.headers.get("x-ratelimit-remaining");
  return Boolean(retryAfter) || remaining === "0";
}

// Parse the retry-after header as integer seconds (the format GitHub uses),
// capped to MAX_RETRY_DELAY_MS. Returns 0 if the header is missing or unparseable.
// Does not handle HTTP-date format since the GitHub API only uses integers.
function parseRetryAfterMs(response: Response): number {
  const header = response.headers.get("retry-after");
  if (!header) return 0;
  const seconds = parseInt(header, 10);
  if (isNaN(seconds) || seconds <= 0) return 0;
  return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
}

export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retryOptions: RetryOptions = {},
): Promise<Response> {
  const timeoutMs = retryOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = retryOptions.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = retryOptions.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      if (isTransientStatus(response) && attempt < retries) {
        const retryAfterMs = parseRetryAfterMs(response);
        await sleep(Math.max(retryAfterMs, baseDelayMs * (attempt + 1)));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(baseDelayMs * (attempt + 1));
        continue;
      }
    }
  }

  throw lastError ?? new Error("fetch failed after retries");
}
