// Resilient execution wrapper for `opencode github run` in GitHub Actions.
//
// Replaces the one-shot inline `timeout 45m opencode github run` shell block with
// a typed boundary that retries once for likely transient failures while preserving
// the existing finalisation contract.
//
// Known limitation: the retry guard only checks the git working tree (clean?)
// and HEAD (unchanged?). It cannot detect GitHub-side effects made by the agent
// such as comments, reviews, labels, or API calls. A fully robust solution would
// require idempotency or request-level retry inside the provider layer, not at
// the process wrapper level.

import { core, getErrorMessage } from "./context";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  outputTail: string;
  attempt: number;
}

export type Classification =
  | "success"
  | "timeout"
  | "command_not_found"
  | "command_not_executable"
  | "sigint"
  | "sigkill"
  | "sigterm"
  | "transient"
  | "unknown_failure";

export interface ClassifiedResult {
  classification: Classification;
  retryable: boolean;
  reason: string;
}

// Narrow patterns anchored to known provider/network failure formats.
// Avoid broad substrings that could match user code, test output, or log lines.
const TRANSIENT_PATTERNS = [
  "Error: The operation was canceled",
  "stream ended unexpectedly",
  "Error: fetch failed",
  "Error: socket hang up",
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ERR_STREAM_ABORT",
  "HTTP 429",
  "HTTP 500",
  "HTTP 502",
  "HTTP 503",
  "HTTP 504",
];

function matchesTransientPattern(output: string): boolean {
  const lower = output.toLowerCase();
  return TRANSIENT_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
}

const EXIT_CODE_MAP: Record<number, ClassifiedResult> = {
  0: { classification: "success", retryable: false, reason: "success" },
  124: { classification: "timeout", retryable: false, reason: "timeout (45m)" },
  126: { classification: "command_not_executable", retryable: false, reason: "command not executable" },
  127: { classification: "command_not_found", retryable: false, reason: "command not found" },
  130: { classification: "sigint", retryable: false, reason: "SIGINT" },
  137: { classification: "sigkill", retryable: false, reason: "SIGKILL / OOM" },
  143: { classification: "sigterm", retryable: false, reason: "SIGTERM" },
};

export function classifyOpenCodeResult(result: RunResult): ClassifiedResult {
  // Exit code takes precedence — known codes map directly
  if (result.exitCode !== null && result.exitCode in EXIT_CODE_MAP) {
    return EXIT_CODE_MAP[result.exitCode];
  }

  // For non-zero exits without a known code, look at the output tail
  if (matchesTransientPattern(result.outputTail)) {
    return {
      classification: "transient",
      retryable: true,
      reason: `transient failure (exit ${result.exitCode ?? "null"}, matched pattern)`,
    };
  }

  return {
    classification: "unknown_failure",
    retryable: false,
    reason: `unknown failure (exit ${result.exitCode ?? "null"}, signal ${result.signal ?? "null"})`,
  };
}

export function shouldRetryOpenCodeResult(result: RunResult, maxAttempts: number): boolean {
  if (result.attempt >= maxAttempts) {
    return false;
  }
  const classified = classifyOpenCodeResult(result);
  return classified.retryable;
}

// ---------------------------------------------------------------------------
// Workspace mutation guard
// ---------------------------------------------------------------------------

export async function checkWorkspaceClean(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      core.warning(`git status exited with ${exitCode}: ${output}`);
      return false;
    }
    return output.trim().length === 0;
  } catch (error) {
    core.warning(`Could not check git status: ${getErrorMessage(error)}`);
    return false;
  }
}

export async function getHeadSha(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      core.warning(`git rev-parse HEAD exited with ${exitCode}: ${output}`);
      return null;
    }
    return output.trim() || null;
  } catch (error) {
    core.warning(`Could not get HEAD SHA: ${getErrorMessage(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Process execution
// ---------------------------------------------------------------------------

export const OUTPUT_TAIL_LIMIT = 64 * 1024; // 64KB

export interface SpawnResult {
  exitCode: number | null;
  signal: string | null;
  outputTail: string;
}

interface SubprocessLike {
  stdout: ReadableStream;
  stderr: ReadableStream;
  exited: Promise<number>;
}

export type SpawnFn = (command: string[], options: { stdout: "pipe"; stderr: "pipe" }) => SubprocessLike;

function defaultSpawnFn(command: string[], options: { stdout: "pipe"; stderr: "pipe" }): SubprocessLike {
  const proc = Bun.spawn(command, options);
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
  };
}

export async function runOpenCode(
  spawnFn: SpawnFn = defaultSpawnFn,
): Promise<SpawnResult> {
  try {
    // Preserve the auth setup that the old inline shell block performed.
    process.env.USE_GITHUB_TOKEN = "true";
    process.env.GITHUB_TOKEN = process.env.GH_TOKEN ?? "";

    const proc = spawnFn(["timeout", "45m", "opencode", "github", "run"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const chunks: Buffer[] = [];
    let totalBytes = 0;

    function pushChunk(data: Uint8Array) {
      const buf = Buffer.from(data);
      if (buf.length > OUTPUT_TAIL_LIMIT) {
        // A single chunk exceeds the limit — keep only its tail and discard
        // everything that came before.
        chunks.length = 0;
        chunks.push(buf.subarray(-OUTPUT_TAIL_LIMIT));
        totalBytes = OUTPUT_TAIL_LIMIT;
        return;
      }

      chunks.push(buf);
      totalBytes += buf.length;

      // Trim oldest bytes until we're under the limit, slicing the first chunk
      // if necessary instead of discarding it entirely. This preserves more of
      // the tail than the old whole-chunk removal strategy.
      while (totalBytes > OUTPUT_TAIL_LIMIT) {
        const excess = totalBytes - OUTPUT_TAIL_LIMIT;
        const first = chunks[0];
        if (first.length <= excess) {
          chunks.shift();
          totalBytes -= first.length;
        } else {
          chunks[0] = first.subarray(excess);
          totalBytes -= excess;
        }
      }
    }

    const stdoutDone = proc.stdout.pipeTo(
      new WritableStream({
        write(chunk: Uint8Array) {
          pushChunk(chunk);
          process.stdout.write(chunk);
        },
      }),
    );

    const stderrDone = proc.stderr.pipeTo(
      new WritableStream({
        write(chunk: Uint8Array) {
          pushChunk(chunk);
          process.stderr.write(chunk);
        },
      }),
    );

    const exitCode = await proc.exited;
    // Wait for stdout/stderr to fully drain before classifying the output.
    // Otherwise the final error line might be missed in a stream-flush race.
    await Promise.allSettled([stdoutDone, stderrDone]);

    const outputTail = Buffer.concat(chunks).toString("utf-8");
    return {
      exitCode: exitCode ?? null,
      signal: null,
      outputTail,
    };
  } catch (error) {
    return {
      exitCode: 1,
      signal: null,
      outputTail: getErrorMessage(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export const MAX_ATTEMPTS = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setRunOutputs(exitCode: number, attempt: number, reason: string): void {
  core.setOutput("exit_code", String(exitCode));
  core.setOutput("attempt_count", String(attempt));
  core.setOutput("final_reason", reason);
}

export async function main(
  runOpenCodeFn = runOpenCode,
  checkWorkspaceCleanFn = checkWorkspaceClean,
  getHeadShaFn = getHeadSha,
): Promise<number> {
  let beforeHead: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    core.info(`Starting opencode github run (attempt ${attempt}/${MAX_ATTEMPTS})`);

    if (attempt === 1) {
      beforeHead = await getHeadShaFn();
    }

    let lastResult: SpawnResult;
    try {
      const startTime = Date.now();
      lastResult = await runOpenCodeFn();
      const durationMs = Date.now() - startTime;

      const result: RunResult = {
        exitCode: lastResult.exitCode,
        signal: lastResult.signal,
        outputTail: lastResult.outputTail,
        attempt,
      };

      const classified = classifyOpenCodeResult(result);

      core.info(
        `opencode attempt ${attempt} finished in ${durationMs}ms with exit_code=${lastResult.exitCode ?? "null"}, classification=${classified.classification}, reason=${classified.reason}`,
      );

      if (classified.classification === "success") {
        setRunOutputs(lastResult.exitCode ?? 0, attempt, classified.reason);
        core.info("opencode completed successfully");
        return 0;
      }

      if (shouldRetryOpenCodeResult(result, MAX_ATTEMPTS)) {
        const isClean = await checkWorkspaceCleanFn();
        if (!isClean) {
          core.error(
            `Retryable failure detected, but workspace is not clean. Refusing to retry to avoid double-applying effects.`,
          );
          setRunOutputs(lastResult.exitCode ?? 1, attempt, "transient_but_workspace_dirty");
          return lastResult.exitCode ?? 1;
        }

        const afterHead = await getHeadShaFn();
        if (beforeHead === null || afterHead === null) {
          core.error(
            `Retryable failure detected, but HEAD state could not be determined (before=${beforeHead ?? "null"}, after=${afterHead ?? "null"}). Refusing to retry to avoid double-applying effects.`,
          );
          setRunOutputs(lastResult.exitCode ?? 1, attempt, "transient_but_head_unknown");
          return lastResult.exitCode ?? 1;
        }

        if (beforeHead !== afterHead) {
          core.error(
            `Retryable failure detected, but HEAD moved (${beforeHead.slice(0, 7)} → ${afterHead.slice(0, 7)}). Refusing to retry to avoid double-applying effects.`,
          );
          setRunOutputs(lastResult.exitCode ?? 1, attempt, "transient_but_head_moved");
          return lastResult.exitCode ?? 1;
        }

        core.warning(`Retryable failure detected: ${classified.reason}. Retrying in 2s...`);
        await sleep(2000);
        continue;
      }

      // Non-retryable failure
      core.error(`opencode failed with non-retryable classification: ${classified.reason}`);
      setRunOutputs(lastResult.exitCode ?? 1, attempt, classified.reason);
      return lastResult.exitCode ?? 1;
    } catch (error) {
      const message = getErrorMessage(error);
      core.error(`Unexpected error during opencode run: ${message}`);
      setRunOutputs(1, attempt, `unexpected_error: ${message}`);
      return 1;
    }
  }

  // Safety net — should never reach here because the loop always returns
  return 1;
}

if (import.meta.main) {
  main()
    .then((exitCode) => process.exit(exitCode))
    .catch((error) => {
      core.setFailed(`run-opencode wrapper failed: ${error}`);
    });
}
