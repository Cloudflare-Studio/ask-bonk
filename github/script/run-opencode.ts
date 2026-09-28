// Runs OpenCode with a small bounded retry for transient provider/session drops.

import { existsSync, readFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { pathToFileURL } from "url";
import {
  appendGitHubValue,
  fitPrompt,
  installOpenCodeDependencies,
  openCodeConfigDirs,
  PROMPT_ENV_CAP,
  readPromptFile,
} from "./context";
import {
  deleteComment,
  findRunResponse,
  readPublishState,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfigObject(content: string): Record<string, unknown> | undefined {
  const bunRuntime = (globalThis as { Bun?: { JSONC?: { parse(value: string): unknown } } }).Bun;
  const parsed = bunRuntime?.JSONC ? bunRuntime.JSONC.parse(content) : JSON.parse(content);
  return isRecord(parsed) ? parsed : undefined;
}

// OpenCode's defaults ask before touching paths outside the workspace and on
// doom loops, and nobody can answer in CI: the run hangs until the job times
// out. These rules go under the consumer's config. OpenCode applies the last
// matching rule, so the leading "*": "deny" only catches paths no consumer or
// Bonk rule allows, and a consumer "*" rule replaces Bonk's rules entirely.
//
// OpenCode deep-merges OPENCODE_CONFIG_CONTENT over its config files, which
// would let these defaults override a file's scalar choices or reorder its
// external_directory rules behind the "*" fallback. A permission the config
// files already set is therefore left to them.
function withNonInteractivePermissions(
  permission: unknown,
  allowedDirs: string[],
  filePermissions: unknown[],
): unknown {
  // A string applies one action to every permission, so nothing asks
  // unless the consumer chose that.
  if (typeof permission === "string") return permission;
  if (filePermissions.some((value) => typeof value === "string")) return permission;
  const setInFiles = (key: string) =>
    filePermissions.some((value) => isRecord(value) && value[key] !== undefined);

  const configured = isRecord(permission) ? permission : {};
  const defaults: Record<string, unknown> = {};
  for (const key of ["question", "doom_loop"]) {
    if (!setInFiles(key)) defaults[key] = "deny";
  }
  const result: Record<string, unknown> = { ...defaults, ...configured };

  const external = configured.external_directory;
  if (
    !setInFiles("external_directory") &&
    (external === undefined || (isRecord(external) && !("*" in external)))
  ) {
    result.external_directory = {
      "*": "deny",
      ...Object.fromEntries(allowedDirs.map((dir) => [`${dir}/**`, "allow"])),
      ...(isRecord(external) ? external : {}),
    };
  }
  return Object.keys(result).length > 0 ? result : permission;
}

// The permission blocks of the config files OpenCode loads for a run in
// `workspace`: global config and project config at the repository root.
export function readConfigFilePermissions(workspace: string | undefined): unknown[] {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const files = [
    ...["config.json", "opencode.json", "opencode.jsonc"].map((file) =>
      join(configHome, "opencode", file),
    ),
    ...(workspace
      ? [
          "opencode.jsonc",
          "opencode.json",
          ".opencode/opencode.json",
          ".opencode/opencode.jsonc",
        ].map((file) => join(workspace, file))
      : []),
  ];
  const permissions: unknown[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const permission = parseConfigObject(readFileSync(file, "utf8"))?.permission;
      if (permission !== undefined) permissions.push(permission);
    } catch {
      // Unknown contents might set anything, and a string permission leaves
      // every permission to the files. OpenCode reports the error itself.
      permissions.push("unreadable");
    }
  }
  return permissions;
}

// OpenCode leaves the Cloudflare AI Gateway provider out entirely when its
// account or gateway ID is missing, and then reports only "Model not found",
// which reads like a wrong model name. Workflows usually hit this when the
// secrets they map are not available to the repository.
export function missingProviderEnv(env: Record<string, string | undefined>): string[] {
  if (!env.MODEL?.startsWith("cloudflare-ai-gateway/")) return [];
  return [
    !env.CLOUDFLARE_ACCOUNT_ID ? "CLOUDFLARE_ACCOUNT_ID" : "",
    !env.CLOUDFLARE_GATEWAY_ID ? "CLOUDFLARE_GATEWAY_ID" : "",
    !env.CLOUDFLARE_API_TOKEN && !env.CF_AIG_TOKEN ? "CLOUDFLARE_API_TOKEN" : "",
  ].filter(Boolean);
}

// `opencode github run` reads its prompt only from the PROMPT env var, which
// Linux caps per string, so the prompt file is fitted under PROMPT_ENV_CAP.
export function resolvePrompt(env: Record<string, string | undefined>): string {
  if (!env.PROMPT_FILE) return env.PROMPT ?? "";
  const spillDir = join(dirname(env.PROMPT_FILE), "spilled");
  return fitPrompt(readPromptFile(env.PROMPT_FILE), PROMPT_ENV_CAP, spillDir);
}

export interface PermissionDefaults {
  // Directories OpenCode may use outside the workspace.
  allowedDirs: string[];
  // Permission blocks from the config files OpenCode also loads.
  filePermissions: unknown[];
}

export function buildOpenCodeConfigContent(
  existingContent: string | undefined,
  guidancePath: string,
  permissionDefaults: PermissionDefaults = { allowedDirs: [], filePermissions: [] },
): string {
  let config: Record<string, unknown> = {};
  if (existingContent?.trim()) {
    const parsed = parseConfigObject(existingContent);
    if (!parsed) {
      throw new Error("OPENCODE_CONFIG_CONTENT must contain a JSON object");
    }
    config = { ...parsed };
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
  const permission = withNonInteractivePermissions(
    config.permission,
    permissionDefaults.allowedDirs,
    permissionDefaults.filePermissions,
  );
  if (permission !== undefined) config.permission = permission;
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
  prompt: string,
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
        PROMPT: prompt,
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
  const state = readPublishState();
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

  const missingEnv = missingProviderEnv(process.env);
  if (missingEnv.length > 0) {
    // A warning, not a failure: OpenCode can also take these from stored
    // credentials or a configured baseURL.
    console.log(
      `::warning::${missingEnv.join(", ")} ${missingEnv.length === 1 ? "is" : "are"} empty, so OpenCode cannot load the Cloudflare AI Gateway provider for ${process.env.MODEL} and will report the model as not found. Check that the secrets mapped to these variables exist and are available to this repository.`,
    );
  }

  let configContent: string;
  try {
    // The workspace, the runner's temp directory (Bonk's review and diff
    // files), and the system temp directory OpenCode offers as scratch space.
    const allowedDirs = [process.env.GITHUB_WORKSPACE, process.env.RUNNER_TEMP, tmpdir()].filter(
      (dir): dir is string => Boolean(dir),
    );
    configContent = buildOpenCodeConfigContent(process.env.OPENCODE_CONFIG_CONTENT, guidancePath, {
      allowedDirs,
      filePermissions: readConfigFilePermissions(process.env.GITHUB_WORKSPACE || process.cwd()),
    });
  } catch (error) {
    console.error(
      `Could not add Bonk harness guidance to OpenCode config: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    writeExitCode(2);
    return 2;
  }

  let prompt: string;
  try {
    prompt = resolvePrompt(process.env);
  } catch (error) {
    console.error(
      `Could not read the prompt: ${error instanceof Error ? error.message : String(error)}`,
    );
    writeExitCode(2);
    return 2;
  }

  await installOpenCodeDependencies(
    openCodeConfigDirs(process.env.GITHUB_WORKSPACE || process.cwd()),
  );

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

    const result = await runOpenCodeAttempt(remainingMs, configContent, prompt);

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
