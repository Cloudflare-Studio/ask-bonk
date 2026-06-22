// Runs OpenCode with a small bounded retry for transient provider/session drops.

import { pathToFileURL } from "url";
import { appendGitHubValue } from "./context";

const DEFAULT_TIMEOUT = "45m";
const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 15_000;
const OUTPUT_TAIL_LIMIT = 64_000;

const NON_RETRYABLE_EXIT_CODES = new Set([
  124, // GNU timeout: command timed out
  125, // GNU timeout internal failure
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

export interface OpenCodeFailure {
  exitCode: number;
  output: string;
}

export function isRetryableOpenCodeFailure({ exitCode, output }: OpenCodeFailure): boolean {
  if (exitCode === 0 || NON_RETRYABLE_EXIT_CODES.has(exitCode)) return false;
  if (GITHUB_CANCELLATION_PATTERNS.some((pattern) => pattern.test(output))) return false;
  return RETRYABLE_FAILURE_PATTERNS.some((pattern) => pattern.test(output));
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
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function retryDelayMs(attempt: number): number {
  const baseDelayMs = parsePositiveInteger(process.env.OPENCODE_RETRY_BASE_DELAY_MS, DEFAULT_BASE_DELAY_MS);
  return Math.min(baseDelayMs * 2 ** (attempt - 1), 60_000);
}

function rememberTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > OUTPUT_TAIL_LIMIT ? next.slice(next.length - OUTPUT_TAIL_LIMIT) : next;
}

async function streamAndCapture(
  stream: ReadableStream<Uint8Array> | null,
  target: NodeJS.WriteStream,
): Promise<string> {
  if (!stream) return "";

  const decoder = new TextDecoder();
  let output = "";

  for await (const chunk of stream) {
    target.write(chunk);
    output = rememberTail(output, decoder.decode(chunk, { stream: true }));
  }

  output = rememberTail(output, decoder.decode());
  return output;
}

async function runOpenCodeAttempt(timeoutMs: number): Promise<OpenCodeFailure> {
  const timeoutSeconds = `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`;
  const proc = Bun.spawn(["timeout", timeoutSeconds, "opencode", "github", "run"], {
    env: {
      ...process.env,
      USE_GITHUB_TOKEN: "true",
      GITHUB_TOKEN: process.env.GH_TOKEN || "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    streamAndCapture(proc.stdout, process.stdout),
    streamAndCapture(proc.stderr, process.stderr),
    proc.exited,
  ]);

  return { exitCode, output: `${stdout}\n${stderr}` };
}

function writeExitCode(exitCode: number): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) appendGitHubValue(outputFile, "exit_code", String(exitCode));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runOpenCodeWithRetry(): Promise<number> {
  const timeoutMs = parseDurationMs(process.env.OPENCODE_TIMEOUT || DEFAULT_TIMEOUT) ??
    parseDurationMs(DEFAULT_TIMEOUT)!;
  const retries = parsePositiveInteger(process.env.OPENCODE_RETRIES, DEFAULT_RETRIES);
  const maxAttempts = retries + 1;
  const startedAt = Date.now();

  let lastExitCode = 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      writeExitCode(124);
      return 124;
    }

    if (attempt > 1) {
      console.log(`Retrying opencode github run (${attempt}/${maxAttempts})`);
    }

    const result = await runOpenCodeAttempt(remainingMs);
    lastExitCode = result.exitCode;

    if (result.exitCode === 0) {
      writeExitCode(result.exitCode);
      return result.exitCode;
    }

    const canRetry = attempt < maxAttempts && isRetryableOpenCodeFailure(result);
    if (!canRetry) {
      if (attempt > 1) {
        console.log(`opencode github run failed after ${attempt} attempts with exit code ${result.exitCode}`);
      }
      writeExitCode(result.exitCode);
      return result.exitCode;
    }

    const remainingAfterAttemptMs = timeoutMs - (Date.now() - startedAt);
    const delayMs = retryDelayMs(attempt);
    if (delayMs >= remainingAfterAttemptMs) {
      console.log("Transient opencode failure detected, but no retry budget remains");
      writeExitCode(result.exitCode);
      return result.exitCode;
    }

    console.log(
      `Transient opencode failure detected (exit code ${result.exitCode}); retrying in ${delayMs}ms`,
    );
    await sleep(delayMs);
  }

  writeExitCode(lastExitCode);
  return lastExitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await runOpenCodeWithRetry();
  process.exit(exitCode);
}
