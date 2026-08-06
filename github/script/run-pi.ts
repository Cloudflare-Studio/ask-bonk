// Runs Pi and delivers its final response to the triggering GitHub thread.

import { execFileSync } from "child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "fs";
import { dirname, resolve } from "path";
import { pathToFileURL } from "url";
import { appendGitHubValue } from "./context";

const DEFAULT_TIMEOUT = "45m";
const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 15_000;
const OUTPUT_TAIL_LIMIT = 64_000;
const STREAM_DRAIN_GRACE_MS = 1_000;
const MAX_GITHUB_COMMENT_LENGTH = 65_000;

const NON_RETRYABLE_EXIT_CODES = new Set([
  124, // Pi timed out
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

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface PiFailure {
  exitCode: number;
  output: string;
  finalResponse: string;
  hadToolExecution: boolean;
}

export function isRetryablePiFailure({ exitCode, output, hadToolExecution }: PiFailure): boolean {
  if (exitCode === 0 || hadToolExecution || NON_RETRYABLE_EXIT_CODES.has(exitCode)) return false;
  if (GITHUB_CANCELLATION_PATTERNS.some((pattern) => pattern.test(output))) return false;
  return RETRYABLE_FAILURE_PATTERNS.some((pattern) => pattern.test(output));
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content.trim();
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

export function loadAgentPrompt(
  agent: string | undefined,
  cwd = process.cwd(),
  actionPath = process.env.BONK_ACTION_PATH,
): string | null {
  const name = agent?.trim();
  if (!name) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new Error(`Invalid agent name "${name}"`);
  }

  const candidates = [
    `${cwd}/.pi/agents/${name}.md`,
    `${cwd}/.agents/agents/${name}.md`,
    // Compatibility for repositories that selected an OpenCode agent before
    // Bonk moved to Pi. Only the Markdown prompt body is reused.
    `${cwd}/.opencode/agents/${name}.md`,
    ...(actionPath ? [`${actionPath}/agents/${name}.md`] : []),
  ];

  const path = candidates.find((candidate) => existsSync(candidate));
  return path ? stripFrontmatter(readFileSync(path, "utf8")) : null;
}

export interface PiArguments {
  model: string;
  prompt: string;
  guidance: string;
  agentPrompt?: string | null;
  thinking?: string;
  skills?: string[];
  approveProject?: boolean;
}

export function buildPiArgs({
  model,
  prompt,
  guidance,
  agentPrompt,
  thinking,
  skills = [],
  approveProject = true,
}: PiArguments): string[] {
  const args = [
    "pi",
    "--mode",
    "json",
    "--no-session",
    approveProject ? "--approve" : "--no-approve",
    // Repository instructions and skills are trusted, but executable Pi
    // extensions and other UI resources are not needed in Actions.
    "--no-extensions",
    "--no-prompt-templates",
    "--no-themes",
    "--model",
    model,
    "--append-system-prompt",
    guidance,
  ];

  if (agentPrompt) {
    args.push("--append-system-prompt", `# Selected Bonk agent\n\n${agentPrompt}`);
  }
  if (thinking && VALID_THINKING_LEVELS.has(thinking)) {
    args.push("--thinking", thinking);
  }
  for (const skill of skills) {
    args.push("--skill", skill);
  }

  // Prefixing prevents a user prompt beginning with '-' or '@' from being
  // interpreted as a Pi flag or file argument.
  args.push(`GitHub task:\n\n${prompt}`);
  return args;
}

function collectSkillFiles(path: string, includeRootMarkdown = false, depth = 0): string[] {
  if (!existsSync(path)) return [];
  const skills: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = `${path}/${entry.name}`;
    if (entry.isDirectory()) {
      skills.push(...collectSkillFiles(entryPath, false, depth + 1));
    } else if (entry.isFile() && (entry.name === "SKILL.md" || (includeRootMarkdown && depth === 0 && entry.name.endsWith(".md")))) {
      skills.push(entryPath);
    }
  }
  return skills;
}

export function discoverProjectSkills(cwd = process.cwd()): string[] {
  let repoRoot = resolve(cwd);
  try {
    repoRoot = resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim());
  } catch {
    // The Action normally runs in a git checkout. Falling back to cwd keeps
    // explicit skill discovery useful in local harness tests.
  }

  const skills = collectSkillFiles(`${repoRoot}/.pi/skills`, true);
  let current = resolve(cwd);
  for (;;) {
    skills.push(...collectSkillFiles(`${current}/.agents/skills`));
    if (current === repoRoot) break;
    const parent = dirname(current);
    if (parent === current || !current.startsWith(`${repoRoot}/`)) break;
    current = parent;
  }
  return Array.from(new Set(skills));
}

export function shouldApproveProject(isFork = process.env.IS_FORK): boolean {
  return isFork !== "true";
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
  const baseDelayMs = parsePositiveInteger(
    process.env.PI_RETRY_BASE_DELAY_MS,
    DEFAULT_BASE_DELAY_MS,
  );
  return Math.min(baseDelayMs * 2 ** (attempt - 1), 60_000);
}

function rememberTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > OUTPUT_TAIL_LIMIT ? next.slice(next.length - OUTPUT_TAIL_LIMIT) : next;
}

function killPiProcess(proc: BunSubprocess, signal: NodeJS.Signals): void {
  try {
    process.kill(-proc.pid, signal);
  } catch {
    proc.kill(signal);
  }
}

export function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const value = message as { role?: unknown; content?: unknown };
  if (value.role !== "assistant") return "";
  if (typeof value.content === "string") return value.content.trim();
  if (!Array.isArray(value.content)) return "";
  return value.content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const block = part as { type?: unknown; text?: unknown };
      return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
    })
    .join("")
    .trim();
}

export function isFailedAssistantMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const value = message as { role?: unknown; stopReason?: unknown };
  return (
    value.role === "assistant" &&
    (value.stopReason === "error" || value.stopReason === "aborted")
  );
}

interface PiStreamResult {
  output: string;
  finalResponse: string;
  hadToolExecution: boolean;
  assistantFailed: boolean;
}

async function streamPiEvents(
  stream: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): Promise<PiStreamResult> {
  if (!stream) {
    return { output: "", finalResponse: "", hadToolExecution: false, assistantFailed: false };
  }

  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffered = "";
  let output = "";
  let finalResponse = "";
  let hadToolExecution = false;
  let assistantFailed = false;
  const abort = () => void reader.cancel();

  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    output = rememberTail(output, `${line}\n`);
    try {
      const event = JSON.parse(line) as {
        type?: string;
        toolName?: string;
        isError?: boolean;
        message?: unknown;
        assistantMessageEvent?: { type?: string; delta?: string };
      };
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta || "");
      } else if (event.type === "message_end") {
        if (isFailedAssistantMessage(event.message)) {
          assistantFailed = true;
        } else {
          const text = extractAssistantText(event.message);
          if (text) finalResponse = text;
        }
      } else if (event.type === "tool_execution_start") {
        hadToolExecution = true;
        process.stdout.write(`\n[pi tool] ${event.toolName || "unknown"}\n`);
      } else if (event.type === "tool_execution_end" && event.isError) {
        process.stdout.write(`[pi tool failed] ${event.toolName || "unknown"}\n`);
      }
    } catch {
      process.stdout.write(`${line}\n`);
    }
  };

  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        consumeLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
      }
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }

  buffered += decoder.decode();
  consumeLine(buffered);
  return { output, finalResponse, hadToolExecution, assistantFailed };
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
  const abort = () => void reader.cancel();

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
  return rememberTail(output, decoder.decode());
}

async function runPiAttempt(timeoutMs: number, args: string[]): Promise<PiFailure> {
  let timedOut = false;
  const controller = new AbortController();
  let proc: BunSubprocess;
  try {
    proc = Bun.spawn(args, {
      detached: true,
      env: {
        ...process.env,
        GITHUB_TOKEN: process.env.GH_TOKEN || "",
        CLOUDFLARE_API_KEY:
          process.env.CLOUDFLARE_API_KEY || process.env.CLOUDFLARE_API_TOKEN || "",
        PI_SKIP_VERSION_CHECK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        exitCode: 127,
        output: error.message,
        finalResponse: "",
        hadToolExecution: false,
      };
    }
    throw error;
  }

  const streamOutput = Promise.all([
    streamPiEvents(proc.stdout, controller.signal),
    streamAndCapture(proc.stderr, process.stderr, controller.signal),
  ]);
  const timeout = setTimeout(
    () => {
      timedOut = true;
      killPiProcess(proc, "SIGTERM");
      killPiProcess(proc, "SIGKILL");
      controller.abort();
    },
    Math.max(1, timeoutMs),
  );

  try {
    const exitCode = await proc.exited;
    clearTimeout(timeout);
    const drainGrace = setTimeout(() => {
      killPiProcess(proc, "SIGTERM");
      killPiProcess(proc, "SIGKILL");
      controller.abort();
    }, STREAM_DRAIN_GRACE_MS);
    const [stdout, stderr] = await streamOutput.finally(() => clearTimeout(drainGrace));
    process.stdout.write("\n");
    return {
      exitCode: timedOut ? 124 : exitCode === 0 && stdout.assistantFailed ? 1 : exitCode,
      output: `${stdout.output}\n${stderr}`,
      finalResponse: stdout.finalResponse,
      hadToolExecution: stdout.hadToolExecution,
    };
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

export async function deliverFinalResponse(response: string): Promise<void> {
  const issueNumber = process.env.ISSUE_NUMBER;
  if (!issueNumber) {
    const stepSummary = process.env.GITHUB_STEP_SUMMARY;
    if (stepSummary) appendFileSync(stepSummary, `## Bonk\n\n${response}\n`);
    console.log(response);
    return;
  }

  const repository = process.env.GITHUB_REPOSITORY || process.env.REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repository || !token) {
    throw new Error("Missing repository or GitHub token for final response delivery");
  }

  const body =
    response.length > MAX_GITHUB_COMMENT_LENGTH
      ? `${response.slice(0, MAX_GITHUB_COMMENT_LENGTH)}\n\n[Response truncated by Bonk]`
      : response;
  const result = await fetch(
    `https://api.github.com/repos/${repository}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ body }),
    },
  );
  if (!result.ok) {
    const detail = await result.text();
    throw new Error(`GitHub comment failed (${result.status}): ${detail}`);
  }
}

export async function runPiWithRetry(): Promise<number> {
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
  const prompt = process.env.PROMPT;
  if (!prompt?.trim()) {
    console.error("Bonk requires a prompt for this event.");
    writeExitCode(2);
    return 2;
  }
  const model = process.env.MODEL;
  if (!model?.trim()) {
    console.error("Bonk requires a Pi model.");
    writeExitCode(2);
    return 2;
  }

  let agentPrompt: string | null;
  try {
    agentPrompt = loadAgentPrompt(process.env.AGENT);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    writeExitCode(2);
    return 2;
  }
  if (process.env.AGENT?.trim() && !agentPrompt) {
    console.warn(
      `Agent "${process.env.AGENT.trim()}" has no repository prompt; continuing with Pi defaults.`,
    );
  }

  const thinking = process.env.VARIANT?.trim();
  if (thinking && !VALID_THINKING_LEVELS.has(thinking)) {
    console.warn(`Ignoring unsupported Pi thinking level "${thinking}".`);
  }
  const args = buildPiArgs({
    model: model.trim(),
    prompt,
    guidance: readFileSync(guidancePath, "utf8"),
    agentPrompt,
    thinking,
    skills: [
      ...discoverProjectSkills(),
      ...(process.env.BONK_ACTION_PATH
        ? [`${process.env.BONK_ACTION_PATH}/skills/cross-repo/SKILL.md`]
        : []),
    ],
    approveProject: shouldApproveProject(),
  });

  const timeoutMs =
    parseDurationMs(process.env.PI_TIMEOUT || DEFAULT_TIMEOUT) ?? parseDurationMs(DEFAULT_TIMEOUT)!;
  const retries = parsePositiveInteger(process.env.PI_RETRIES, DEFAULT_RETRIES);
  const maxAttempts = retries + 1;
  const startedAt = Date.now();

  for (let attempt = 1; ; attempt++) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      writeExitCode(124);
      return 124;
    }
    if (attempt > 1) console.log(`Retrying Pi (${attempt}/${maxAttempts})`);

    const result = await runPiAttempt(remainingMs, args);
    if (result.exitCode === 0) {
      if (!result.finalResponse) {
        console.error("Pi completed without a final response.");
        writeExitCode(2);
        return 2;
      }
      try {
        await deliverFinalResponse(result.finalResponse);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        writeExitCode(1);
        return 1;
      }
      writeExitCode(0);
      return 0;
    }

    const canRetry = attempt < maxAttempts && isRetryablePiFailure(result);
    if (!canRetry) {
      if (attempt > 1) {
        console.log(`Pi failed after ${attempt} attempts with exit code ${result.exitCode}`);
      }
      writeExitCode(result.exitCode);
      return result.exitCode;
    }

    const remainingAfterAttemptMs = timeoutMs - (Date.now() - startedAt);
    const delayMs = retryDelayMs(attempt);
    if (delayMs >= remainingAfterAttemptMs) {
      console.log("Transient Pi failure detected, but no retry budget remains");
      writeExitCode(result.exitCode);
      return result.exitCode;
    }
    console.log(
      `Transient Pi failure detected (exit code ${result.exitCode}); retrying in ${delayMs}ms`,
    );
    await sleep(delayMs);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await runPiWithRetry();
  process.exit(exitCode);
}
