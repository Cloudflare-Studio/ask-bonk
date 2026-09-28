// Runs OpenCode with a small bounded retry for transient provider/session drops.

import { existsSync } from "fs";
import { pathToFileURL } from "url";
import { appendGitHubValue } from "./context";
import {
  deleteComment,
  findRunResponse,
  parsePublishState,
  readReviewFile,
  reviewCompleted,
} from "./review-publish";

const DEFAULT_TIMEOUT = "45m";
const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 15_000;
const OUTPUT_TAIL_LIMIT = 64_000;
const STREAM_DRAIN_GRACE_MS = 1_000;

const NON_RETRYABLE_EXIT_CODES = new Set([
  124, // opencode run timed out
  126, // command found but not executable
  127, // command not found
  130, // SIGINT
  137, // SIGKILL
  143, // SIGTERM
]);

const GITHUB_CANCELLATION_PATTERNS = [
  /workflow (?:run )?(?:was )?cancel(?:led|ed)/i,
  /the operation was canceled because the workflow/i,
  /runner .*shutdown signal/i,
  /received (?:SIGINT|SIGTERM|SIGKILL)/i,
];

const RETRYABLE_FAILURE_PATTERNS = [
  /error:\s*the operation was cancel(?:led|ed)\.?/i,
  /\boperation was cancel(?:led|ed)\b/i,
  /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED)\b/i,
  /\bfetch failed\b/i,
  /\bnetwork (?:error|failure)\b/i,
  /\btemporarily unavailable\b/i,
  /\bprovider\b.*\b(?:timeout|timed out|overloaded|unavailable|connection|stream)\b/i,
  /\bstream\b.*\b(?:error|closed|reset|terminated)\b/i,
];

// Exit code for a review run that finished without producing a review.
export const INCOMPLETE_REVIEW_EXIT_CODE = 3;

export interface OpenCodeFailure {
  exitCode: number;
  output: string;
}

export type FailureCause =
  | "timeout"
  | "content_filter"
  | "provider_errors"
  | "permission_blocked"
  | "incomplete_review";

const CONTENT_FILTER_PATTERN =
  /content[_ -]?(?:filter|policy|management)|ResponsibleAIPolicyViolation|blocked by (?:content|safety)|safety (?:system|filter)/i;
const PROVIDER_ERROR_PATTERN =
  /\b(?:500|502|503|504|529)\b|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|\boverloaded\b/gi;
const PERMISSION_BLOCKED_PATTERN =
  /\bpermission\b[^\n]*\b(?:ask|asked|requested|rejected|denied|required)\b|doom[_ ]loop/i;

// Best-effort label for logs and the finalize step; null when nothing matches.
export function classifyOpenCodeFailure({ exitCode, output }: OpenCodeFailure): FailureCause | null {
  if (exitCode === 0) return null;
  if (exitCode === INCOMPLETE_REVIEW_EXIT_CODE) return "incomplete_review";
  if (exitCode === 124) return "timeout";
  if (CONTENT_FILTER_PATTERN.test(output)) return "content_filter";
  if ((output.match(PROVIDER_ERROR_PATTERN) ?? []).length >= 2) return "provider_errors";
  if (PERMISSION_BLOCKED_PATTERN.test(output)) return "permission_blocked";
  return null;
}

export function isRetryableOpenCodeFailure({ exitCode, output }: OpenCodeFailure): boolean {
  if (exitCode === 0 || NON_RETRYABLE_EXIT_CODES.has(exitCode)) return false;
  if (GITHUB_CANCELLATION_PATTERNS.some((pattern) => pattern.test(output))) return false;
  return RETRYABLE_FAILURE_PATTERNS.some((pattern) => pattern.test(output));
}

export function buildOpenCodeConfigContent(
  existingContent: string | undefined,
  guidancePath: string,
): string {
  let config: Record<string, unknown> = {};
  if (existingContent?.trim()) {
    const bunRuntime = (globalThis as { Bun?: { JSONC?: { parse(value: string): unknown } } }).Bun;
    const parsed = bunRuntime?.JSONC
      ? bunRuntime.JSONC.parse(existingContent)
      : (JSON.parse(existingContent) as unknown);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("OPENCODE_CONFIG_CONTENT must contain a JSON object");
    }
    config = { ...(parsed as Record<string, unknown>) };
  }

  const configuredInstructions = config.instructions;
  if (
    configuredInstructions !== undefined &&
    (!Array.isArray(configuredInstructions) ||
      configuredInstructions.some((instruction) => typeof instruction !== "string"))
  ) {
    throw new Error("OPENCODE_CONFIG_CONTENT instructions must be an array of strings");
  }

  config.instructions = Array.from(
    new Set([...((configuredInstructions as string[] | undefined) ?? []), guidancePath]),
  );
  return JSON.stringify(config);
}

function parseDurationMs(value: string): number | null {
  const match = value.trim().match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) return null;

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] || "s";

  switch (unit) {
    case "ms":
      return amount;
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60 * 1000;
    case "h":
      return amount * 60 * 60 * 1000;
  }
  return null;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// The action's `timeout`/`retries` inputs arrive as BONK_*; the OPENCODE_*
// variables predate those inputs and remain supported for existing workflows.
export function resolveRunLimits(env: Record<string, string | undefined>): {
  timeoutMs: number;
  retries: number;
} {
  const rawTimeout = env.BONK_TIMEOUT?.trim() || env.OPENCODE_TIMEOUT?.trim() || DEFAULT_TIMEOUT;
  let timeoutMs = parseDurationMs(rawTimeout);
  if (timeoutMs === null || timeoutMs <= 0) {
    console.warn(`Invalid OpenCode timeout "${rawTimeout}"; using ${DEFAULT_TIMEOUT}`);
    timeoutMs = parseDurationMs(DEFAULT_TIMEOUT)!;
  }

  const rawRetries = env.BONK_RETRIES?.trim() || env.OPENCODE_RETRIES?.trim();
  const retries = parsePositiveInteger(rawRetries, DEFAULT_RETRIES);
  return { timeoutMs, retries };
}

function retryDelayMs(attempt: number): number {
  const baseDelayMs = parsePositiveInteger(process.env.OPENCODE_RETRY_BASE_DELAY_MS, DEFAULT_BASE_DELAY_MS);
  return Math.min(baseDelayMs * 2 ** (attempt - 1), 60_000);
}

function rememberTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > OUTPUT_TAIL_LIMIT ? next.slice(next.length - OUTPUT_TAIL_LIMIT) : next;
}

function killOpenCodeProcess(proc: BunSubprocess, signal: NodeJS.Signals): void {
  try {
    process.kill(-proc.pid, signal);
  } catch {
    proc.kill(signal);
  }
}

async function streamAndCapture(
  stream: ReadableStream<Uint8Array> | null,
  target: NodeJS.WriteStream,
  signal?: AbortSignal,
): Promise<string> {
  if (!stream) return "";

  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let output = "";
  const abort = () => {
    void reader.cancel();
  };

  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      target.write(value);
      output = rememberTail(output, decoder.decode(value, { stream: true }));
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }

  output = rememberTail(output, decoder.decode());
  return output;
}

async function runOpenCodeAttempt(
  timeoutMs: number,
  configContent: string,
): Promise<OpenCodeFailure> {
  let timedOut = false;
  const controller = new AbortController();
  let proc: BunSubprocess;
  try {
    proc = Bun.spawn(["opencode", "github", "run"], {
      detached: true,
      env: {
        ...process.env,
        USE_GITHUB_TOKEN: "true",
        GITHUB_TOKEN: process.env.GH_TOKEN || "",
        OPENCODE_CONFIG_CONTENT: configContent,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { exitCode: 127, output: error.message };
    }
    throw error;
  }
  const streamOutput = Promise.all([
    streamAndCapture(proc.stdout, process.stdout, controller.signal),
    streamAndCapture(proc.stderr, process.stderr, controller.signal),
  ]);
  const timeout = setTimeout(() => {
    timedOut = true;
    killOpenCodeProcess(proc, "SIGTERM");
    killOpenCodeProcess(proc, "SIGKILL");
    controller.abort();
  }, Math.max(1, timeoutMs));

  try {
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    const drainGrace = setTimeout(() => {
      killOpenCodeProcess(proc, "SIGTERM");
      killOpenCodeProcess(proc, "SIGKILL");
      controller.abort();
    }, STREAM_DRAIN_GRACE_MS);
    const [stdout, stderr] = await streamOutput.finally(() => clearTimeout(drainGrace));

    return { exitCode: timedOut ? 124 : exitCode, output: `${stdout}\n${stderr}` };
  } finally {
    clearTimeout(timeout);
  }
}

function writeExitCode(exitCode: number, output = ""): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) appendGitHubValue(outputFile, "exit_code", String(exitCode));
  const cause = classifyOpenCodeFailure({ exitCode, output });
  if (!cause) return;
  console.log(`OpenCode failure cause: ${cause}`);
  if (outputFile) appendGitHubValue(outputFile, "failure_cause", cause);
}

// A review run must end with a review. OpenCode exits 0 as long as it posted
// something, so check for the findings file or a verdict line. An attempt
// without either is removed so its text never stands in for a review.
// GitHub API failures count as complete: this check must not fail good runs.
export async function checkReviewCompletion(): Promise<boolean> {
  const state = parsePublishState(process.env.REVIEW_STATE);
  if (!state?.expectReview || readReviewFile(state.reviewFile)) return true;
  const token = process.env.GH_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY || "";
  const prNumber = process.env.PR_NUMBER || "";
  const runId = process.env.GITHUB_RUN_ID || "";
  if (!token || !repository || !prNumber || !runId) return true;
  try {
    const { response } = await findRunResponse(token, repository, prNumber, runId);
    if (response && reviewCompleted(null, response.body)) return true;
    if (response?.databaseId) await deleteComment(token, repository, response.databaseId);
    return false;
  } catch (error) {
    console.log(`Could not check the review: ${error}`);
    return true;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runOpenCodeWithRetry(): Promise<number> {
  if (process.platform === "win32") {
    console.error("Bonk GitHub Action requires a Linux or macOS runner.");
    writeExitCode(126);
    return 126;
  }

  const guidancePath = process.env.BONK_GUIDANCE_PATH;
  if (!guidancePath || !existsSync(guidancePath)) {
    console.error("Bonk harness guidance file is missing.");
    writeExitCode(2);
    return 2;
  }

  let configContent: string;
  try {
    configContent = buildOpenCodeConfigContent(process.env.OPENCODE_CONFIG_CONTENT, guidancePath);
  } catch (error) {
    console.error(
      `Could not add Bonk harness guidance to OpenCode config: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    writeExitCode(2);
    return 2;
  }

  const { timeoutMs, retries } = resolveRunLimits(process.env);
  const maxAttempts = retries + 1;
  const startedAt = Date.now();

  for (let attempt = 1; ; attempt++) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      writeExitCode(124);
      return 124;
    }

    if (attempt > 1) {
      console.log(`Retrying opencode github run (${attempt}/${maxAttempts})`);
    }

    const result = await runOpenCodeAttempt(remainingMs, configContent);

    if (result.exitCode === 0) {
      if (await checkReviewCompletion()) {
        writeExitCode(result.exitCode);
        return result.exitCode;
      }
      console.log("::warning::OpenCode finished without a review (no findings file and no verdict line)");
      if (attempt < maxAttempts && timeoutMs - (Date.now() - startedAt) > 0) {
        console.log("Retrying the review");
        continue;
      }
      writeExitCode(INCOMPLETE_REVIEW_EXIT_CODE);
      return INCOMPLETE_REVIEW_EXIT_CODE;
    }

    const canRetry = attempt < maxAttempts && isRetryableOpenCodeFailure(result);
    if (!canRetry) {
      if (attempt > 1) {
        console.log(`opencode github run failed after ${attempt} attempts with exit code ${result.exitCode}`);
      }
      writeExitCode(result.exitCode, result.output);
      return result.exitCode;
    }

    const remainingAfterAttemptMs = timeoutMs - (Date.now() - startedAt);
    const delayMs = retryDelayMs(attempt);
    if (delayMs >= remainingAfterAttemptMs) {
      console.log("Transient opencode failure detected, but no retry budget remains");
      writeExitCode(result.exitCode, result.output);
      return result.exitCode;
    }

    console.log(
      `Transient opencode failure detected (exit code ${result.exitCode}); retrying in ${delayMs}ms`,
    );
    await sleep(delayMs);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await runOpenCodeWithRetry();
  process.exit(exitCode);
}
