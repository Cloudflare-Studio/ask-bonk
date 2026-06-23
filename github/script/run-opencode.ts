// Runs OpenCode with a small bounded retry for transient provider/session drops.

import { pathToFileURL } from "url";
import { appendGitHubValue } from "./context";

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
  return null;
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

async function runOpenCodeAttempt(timeoutMs: number): Promise<OpenCodeFailure> {
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

function writeExitCode(exitCode: number): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) appendGitHubValue(outputFile, "exit_code", String(exitCode));
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

  const timeoutMs = parseDurationMs(process.env.OPENCODE_TIMEOUT || DEFAULT_TIMEOUT) ??
    parseDurationMs(DEFAULT_TIMEOUT)!;
  const retries = parsePositiveInteger(process.env.OPENCODE_RETRIES, DEFAULT_RETRIES);
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

    const result = await runOpenCodeAttempt(remainingMs);

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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await runOpenCodeWithRetry();
  process.exit(exitCode);
}
