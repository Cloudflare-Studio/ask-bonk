import { beforeEach, describe, expect, it, vi } from "vitest";
import { core } from "../github/script/context";
import {
  classifyOpenCodeResult,
  shouldRetryOpenCodeResult,
  runOpenCode,
  main,
  OUTPUT_TAIL_LIMIT,
  type SpawnFn,
  type SpawnResult,
} from "../github/script/run-opencode";
import type { RunResult } from "../github/script/run-opencode";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    exitCode: 0,
    signal: null,
    outputTail: "",
    attempt: 1,
    ...overrides,
  };
}

// Test double for SpawnFn that returns real ReadableStream objects.
// Exercises the actual stream wiring in runOpenCode without requiring
// Bun.spawn (which is unavailable in the Workers test environment).
function spawnTestDouble(
  stdoutData: string,
  stderrData: string,
  exitCode: number,
): SpawnFn {
  return () => ({
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdoutData));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stderrData));
        controller.close();
      },
    }),
    exited: Promise.resolve(exitCode),
  });
}

// ---------------------------------------------------------------------------
// OpenCode Run Classification
// ---------------------------------------------------------------------------

describe("classifyOpenCodeResult", () => {
  it.each([
    { exitCode: 0, classification: "success", retryable: false, label: "success" },
    { exitCode: 124, classification: "timeout", retryable: false, label: "timeout" },
    { exitCode: 126, classification: "command_not_executable", retryable: false, label: "not executable" },
    { exitCode: 127, classification: "command_not_found", retryable: false, label: "not found" },
    { exitCode: 130, classification: "sigint", retryable: false, label: "SIGINT" },
    { exitCode: 137, classification: "sigkill", retryable: false, label: "SIGKILL" },
    { exitCode: 143, classification: "sigterm", retryable: false, label: "SIGTERM" },
  ])("exit %d → %s", ({ exitCode, classification, retryable }) => {
    const result = classifyOpenCodeResult(makeResult({ exitCode }));
    expect(result.classification).toBe(classification);
    expect(result.retryable).toBe(retryable);
  });

  it.each([
    { exitCode: 1, outputTail: "some error", classification: "unknown_failure", retryable: false, label: "unknown failure" },
    { exitCode: 1, outputTail: "Error: The operation was canceled", classification: "transient", retryable: true, label: "transient pattern" },
    { exitCode: 1, outputTail: "stream ended unexpectedly", classification: "transient", retryable: true, label: "stream ended" },
    { exitCode: 1, outputTail: "Error: fetch failed: 502", classification: "transient", retryable: true, label: "fetch failure" },
    { exitCode: 1, outputTail: "HTTP 429", classification: "transient", retryable: true, label: "rate limit" },
    { exitCode: 1, outputTail: "HTTP 503", classification: "transient", retryable: true, label: "503" },
    { exitCode: 1, outputTail: "ECONNRESET", classification: "transient", retryable: true, label: "network error" },
  ])("exit %d with %s → %s", ({ exitCode, outputTail, classification, retryable }) => {
    const result = classifyOpenCodeResult(makeResult({ exitCode, outputTail }));
    expect(result.classification).toBe(classification);
    expect(result.retryable).toBe(retryable);
  });

  it.each([
    { outputTail: "Test output: 500 Internal Server Error", label: "normal test output" },
    { outputTail: "Expected fetch failed", label: "plain fetch failed without Error: prefix" },
    { outputTail: "The operation was canceled", label: "The operation was canceled without Error: prefix" },
  ])("does not classify as transient when output contains $label", ({ outputTail }) => {
    const result = classifyOpenCodeResult(makeResult({ exitCode: 1, outputTail }));
    expect(result.classification).toBe("unknown_failure");
    expect(result.retryable).toBe(false);
  });
});

describe("shouldRetryOpenCodeResult", () => {
  it.each([
    { exitCode: 1, outputTail: "stream ended unexpectedly", attempt: 1, maxAttempts: 2, expected: true, label: "transient within limit" },
    { exitCode: 1, outputTail: "stream ended unexpectedly", attempt: 2, maxAttempts: 2, expected: false, label: "at limit" },
    { exitCode: 124, outputTail: "", attempt: 1, maxAttempts: 2, expected: false, label: "non-retryable classification" },
    { exitCode: 1, outputTail: "some error", attempt: 1, maxAttempts: 2, expected: false, label: "unknown failure" },
  ])("$label", ({ exitCode, outputTail, attempt, maxAttempts, expected }) => {
    const result = makeResult({ exitCode, outputTail, attempt });
    expect(shouldRetryOpenCodeResult(result, maxAttempts)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// runOpenCode — tested with real ReadableStream test doubles
// ---------------------------------------------------------------------------

describe("runOpenCode", () => {
  it("captures stdout and stderr output", async () => {
    const result = await runOpenCode(spawnTestDouble("hello stdout\n", "hello stderr\n", 0));
    expect(result.exitCode).toBe(0);
    expect(result.outputTail).toContain("hello stdout");
    expect(result.outputTail).toContain("hello stderr");
  });

  it("slices oversized output to preserve the tail", async () => {
    const oversized = "a".repeat(OUTPUT_TAIL_LIMIT + 1000);
    const result = await runOpenCode(spawnTestDouble(oversized, "", 1));
    expect(result.outputTail.length).toBe(OUTPUT_TAIL_LIMIT);
    expect(result.outputTail).toBe("a".repeat(OUTPUT_TAIL_LIMIT));
  });

  it("waits for stdout and stderr to drain before resolving", async () => {
    const result = await runOpenCode(
      spawnTestDouble("final stdout line", "final stderr line", 1),
    );
    expect(result.outputTail).toContain("final stdout line");
    expect(result.outputTail).toContain("final stderr line");
  });

  it("returns error output when spawn fails", async () => {
    const throwingSpawn: SpawnFn = () => {
      throw new Error("spawn failed");
    };
    const result = await runOpenCode(throwingSpawn);
    expect(result.exitCode).toBe(1);
    expect(result.outputTail).toContain("spawn failed");
  });
});

// ---------------------------------------------------------------------------
// main retry loop — tested with real functions, not vi.fn mocks
// ---------------------------------------------------------------------------

describe("main", () => {
  beforeEach(() => {
    // core.setOutput uses appendFileSync on GITHUB_OUTPUT. The Workers
    // test environment does not support filesystem append, so we spy on
    // setOutput to capture writes in memory. This is the only mock in the
    // test suite — all other tests exercise real code paths.
    vi.restoreAllMocks();
    vi.spyOn(core, "setOutput").mockImplementation(() => {});
  });

  it("succeeds on first attempt", async () => {
    const run = async () => ({
      exitCode: 0,
      signal: null,
      outputTail: "success",
    });
    const clean = () => Promise.resolve(true);
    const headSha = () => Promise.resolve("abc1234");

    const exitCode = await main(run, clean, headSha);
    expect(exitCode).toBe(0);

    expect(core.setOutput).toHaveBeenCalledWith("exit_code", "0");
    expect(core.setOutput).toHaveBeenCalledWith("attempt_count", "1");
    expect(core.setOutput).toHaveBeenCalledWith("final_reason", "success");
  });

  it("retries transient failure then succeeds", async () => {
    let callCount = 0;
    const run = async () => {
      callCount++;
      if (callCount === 1) {
        return runOpenCode(
          spawnTestDouble("Error: The operation was canceled", "", 1),
        );
      }
      return runOpenCode(spawnTestDouble("success", "", 0));
    };
    const clean = () => Promise.resolve(true);
    const headSha = () => Promise.resolve("abc1234");

    const exitCode = await main(run, clean, headSha);
    expect(exitCode).toBe(0);
    expect(callCount).toBe(2);

    expect(core.setOutput).toHaveBeenCalledWith("exit_code", "0");
    expect(core.setOutput).toHaveBeenCalledWith("attempt_count", "2");
    expect(core.setOutput).toHaveBeenCalledWith("final_reason", "success");
  });

  it("does not retry when workspace is dirty", async () => {
    const run = async () =>
      runOpenCode(spawnTestDouble("Error: The operation was canceled", "", 1));
    const clean = () => Promise.resolve(false);
    const headSha = () => Promise.resolve("abc1234");

    const exitCode = await main(run, clean, headSha);
    expect(exitCode).toBe(1);

    expect(core.setOutput).toHaveBeenCalledWith("exit_code", "1");
    expect(core.setOutput).toHaveBeenCalledWith("attempt_count", "1");
    expect(core.setOutput).toHaveBeenCalledWith("final_reason", "transient_but_workspace_dirty");
  });

  it("does not retry when HEAD moved but workspace is clean", async () => {
    let callCount = 0;
    const run = async () => {
      callCount++;
      return runOpenCode(spawnTestDouble("Error: The operation was canceled", "", 1));
    };
    const clean = () => Promise.resolve(true);
    const headSha = () => Promise.resolve(callCount === 1 ? "abc1234" : "def5678");

    const exitCode = await main(run, clean, headSha);
    expect(exitCode).toBe(1);
    expect(callCount).toBe(1);

    expect(core.setOutput).toHaveBeenCalledWith("exit_code", "1");
    expect(core.setOutput).toHaveBeenCalledWith("attempt_count", "1");
    expect(core.setOutput).toHaveBeenCalledWith("final_reason", "transient_but_head_moved");
  });

  it("does not retry when HEAD cannot be determined", async () => {
    const run = async () =>
      runOpenCode(spawnTestDouble("Error: The operation was canceled", "", 1));
    const clean = () => Promise.resolve(true);
    const headSha = () => Promise.resolve(null);

    const exitCode = await main(run, clean, headSha);
    expect(exitCode).toBe(1);

    expect(core.setOutput).toHaveBeenCalledWith("exit_code", "1");
    expect(core.setOutput).toHaveBeenCalledWith("attempt_count", "1");
    expect(core.setOutput).toHaveBeenCalledWith("final_reason", "transient_but_head_unknown");
  });

  it("does not retry non-retryable failure", async () => {
    const run = async () => ({
      exitCode: 127,
      signal: null,
      outputTail: "",
    });
    const clean = () => Promise.resolve(true);
    const headSha = () => Promise.resolve("abc1234");

    const exitCode = await main(run, clean, headSha);
    expect(exitCode).toBe(127);

    expect(core.setOutput).toHaveBeenCalledWith("exit_code", "127");
    expect(core.setOutput).toHaveBeenCalledWith("attempt_count", "1");
    expect(core.setOutput).toHaveBeenCalledWith("final_reason", "command not found");
  });

  it("handles unexpected errors from runOpenCode", async () => {
    const run = async () => {
      throw new Error("spawn failed");
    };
    const clean = () => Promise.resolve(true);
    const headSha = () => Promise.resolve("abc1234");

    const exitCode = await main(run, clean, headSha);
    expect(exitCode).toBe(1);

    expect(core.setOutput).toHaveBeenCalledWith("exit_code", "1");
    expect(core.setOutput).toHaveBeenCalledWith("attempt_count", "1");
    expect(core.setOutput).toHaveBeenCalledWith("final_reason", "unexpected_error: spawn failed");
  });
});
