import { RequestError } from '@octokit/request-error';
import { Result } from 'better-result';
import { log, sanitizeSecrets } from './log';
import { RetryExhaustedError } from './errors';

// Retry helper for transient failures (network, rate limits).
// 3 attempts total, exponential backoff starting at 5s (5s, 10s).
// Returns Result to distinguish successful completion from exhausted retries.
export async function withRetryResult<T>(
	fn: () => Promise<T>,
	label: string,
): Promise<Result<T, RetryExhaustedError>> {
	const maxAttempts = 3;
	const baseDelayMs = 5000;
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return Result.ok(await fn());
		} catch (err) {
			// Don't retry client errors (4xx) - they won't succeed on retry
			if (err instanceof RequestError && err.status >= 400 && err.status < 500) {
				return Result.err(new RetryExhaustedError({ label, attempts: 1, cause: err }));
			}

			lastError = err;

			if (attempt === maxAttempts) {
				break;
			}

			const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
			const rawMessage = err instanceof Error ? err.message : String(err);
			log.warn('retry_attempt_failed', {
				label,
				attempt,
				max_attempts: maxAttempts,
				delay_ms: delayMs,
				error_message: sanitizeSecrets(rawMessage),
			});
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}

	return Result.err(new RetryExhaustedError({ label, attempts: maxAttempts, cause: lastError }));
}

// Original withRetry that throws - kept for backward compatibility with existing code
// that expects exceptions. Prefer withRetryResult for new code.
export async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
	const result = await withRetryResult(fn, label);
	if (result.isErr()) {
		throw result.error.cause;
	}
	return result.value;
}
