// Context helper for GitHub Action scripts
// Provides a similar interface to actions/github-script's context object

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { fetchWithRetry } from "./http";

const DEFAULT_OIDC_AUDIENCE = "opencode-github-action";
const oidcTokenCache = new Map<string, Promise<string>>();

export interface Repo {
  owner: string;
  repo: string;
}

export interface Issue {
  number: number;
}

export interface Comment {
  id: number;
  createdAt: string;
}

export interface Context {
  repo: Repo;
  issue: Issue | null;
  comment: Comment | null;
  // Timestamp of the triggering event (comment, issue, or PR creation).
  // Falls back to current time if no timestamp env var is available.
  createdAt: string;
  eventName: string;
  runId: number;
  runUrl: string;
  serverUrl: string;
  actor: string;
  ref: string;
  defaultBranch: string;
}

export interface Core {
  info: (message: string) => void;
  warning: (message: string) => void;
  error: (message: string) => void;
  setFailed: (message: string) => never;
  setOutput: (name: string, value: string) => void;
}

function parseRequiredInt(name: string, value: string | undefined): number {
  if (!value) {
    throw new Error(`Missing required ${name}`);
  }
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function parseOptionalInt(name: string, value: string | undefined): number | null {
  if (!value) return null;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

// Build context from environment variables
export function getContext(): Context {
  const owner = process.env.GITHUB_REPOSITORY_OWNER;
  const repo = process.env.GITHUB_REPOSITORY_NAME;
  const runIdValue = process.env.GITHUB_RUN_ID;
  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const repository = process.env.GITHUB_REPOSITORY;

  if (!owner || !repo || !runIdValue || !repository) {
    throw new Error("Missing required GitHub environment variables");
  }

  const runId = parseRequiredInt("GITHUB_RUN_ID", runIdValue);

  const issueNumber = process.env.ISSUE_NUMBER || process.env.PR_NUMBER;
  const commentId = process.env.COMMENT_ID;
  const createdAt = process.env.COMMENT_CREATED_AT || process.env.ISSUE_CREATED_AT;
  const parsedIssueNumber = parseOptionalInt("ISSUE_NUMBER/PR_NUMBER", issueNumber);
  const parsedCommentId = parseOptionalInt("COMMENT_ID", commentId);

  return {
    repo: { owner, repo },
    issue: parsedIssueNumber !== null ? { number: parsedIssueNumber } : null,
    comment:
      parsedCommentId !== null
        ? {
            id: parsedCommentId,
            createdAt: createdAt || new Date().toISOString(),
          }
        : null,
    createdAt: createdAt || new Date().toISOString(),
    eventName: process.env.EVENT_NAME || process.env.GITHUB_EVENT_NAME || "",
    runId,
    runUrl: `${serverUrl}/${repository}/actions/runs/${runId}`,
    serverUrl,
    actor: process.env.GITHUB_ACTOR || "",
    ref: process.env.GITHUB_REF || "",
    defaultBranch: process.env.DEFAULT_BRANCH || "main",
  };
}

// Writes a name=value pair to a GitHub Actions file (GITHUB_OUTPUT or GITHUB_ENV).
// Multiline values use a random heredoc delimiter to prevent injection.
export function appendGitHubValue(filePath: string, name: string, value: string): void {
  if (value.includes("\n")) {
    const delimiter = `BONK_${crypto.randomUUID().replace(/-/g, "")}`;
    appendFileSync(filePath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  } else {
    appendFileSync(filePath, `${name}=${value}\n`);
  }
}

// The prompt and the review state travel between steps as files, never as
// step outputs expanded into env vars: Linux rejects any single environment
// string over 128 KiB (MAX_ARG_STRLEN) with E2BIG, and a review prompt, or
// the state of a re-review touching thousands of files, can be larger.
// `opencode github run` still reads its prompt from the PROMPT env var, so
// run-opencode fits the final prompt under PROMPT_ENV_CAP first.
export const PROMPT_ENV_CAP = 96 * 1024;

// Writes a file for later steps of this run and returns its path.
export function writeRunFile(name: string, content: string): string {
  const base = process.env.RUNNER_TEMP || tmpdir();
  const dir = join(base, `bonk-run-${process.env.GITHUB_RUN_ID || "local"}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

// Writes a prompt stage (e.g. "preflight", "specialists") and returns its path.
export function writePromptFile(stage: string, prompt: string): string {
  return writeRunFile(`prompt-${stage}.md`, prompt);
}

export function readPromptFile(path: string | undefined): string {
  if (!path) return "";
  return readFileSync(path, "utf8");
}

// Top-level Bonk blocks, largest first. Block contents never hold a Bonk tag
// (escapePromptValue and neutralizeTags escape them), so the first matching
// closing tag ends the block.
const PROMPT_BLOCK_PATTERN = /^<(bonk_[a-z_]+)>\n[\s\S]*?\n<\/\1>$/gm;
// Small and structural; the model needs it inline.
const INLINE_ONLY_BLOCKS = new Set(["bonk_execution_context"]);

// Returns a prompt no larger than `cap` bytes. When the prompt is larger, the
// largest blocks move to files in `dir`, each replaced by a pointer telling
// the model to read the file in full; if that is not enough, the whole prompt
// moves to a file.
export function fitPrompt(prompt: string, cap: number, dir: string): string {
  if (Buffer.byteLength(prompt) <= cap) return prompt;
  mkdirSync(dir, { recursive: true });
  const blocks = [...prompt.matchAll(PROMPT_BLOCK_PATTERN)]
    .filter((match) => !INLINE_ONLY_BLOCKS.has(match[1]))
    .map((match) => ({ name: match[1], text: match[0] }))
    .sort((a, b) => Buffer.byteLength(b.text) - Buffer.byteLength(a.text));

  let fitted = prompt;
  for (const block of blocks) {
    if (Buffer.byteLength(fitted) <= cap) break;
    const file = join(dir, `${block.name}.md`);
    writeFileSync(file, `${block.text}\n`);
    const pointer = [
      `<${block.name}>`,
      `moved_to_file: ${escapePromptValue(file)}`,
      `This block is ${Buffer.byteLength(block.text)} bytes, too large to include here. Before you review, read that file in full (page through it if a read is truncated); it holds this block's complete content and counts exactly as if it appeared here.`,
      `</${block.name}>`,
    ].join("\n");
    fitted = fitted.replace(block.text, () => pointer);
  }
  if (Buffer.byteLength(fitted) <= cap) return fitted;

  const file = join(dir, "prompt.md");
  writeFileSync(file, prompt);
  return `Your instructions are ${Buffer.byteLength(prompt)} bytes, too large to include here. Read ${escapePromptValue(file)} in full (page through it if a read is truncated) before doing anything else, and follow it as your instructions.`;
}

// OpenCode installs each config directory's package.json dependencies in the
// background at startup, so a repository's custom tool can load before
// `@opencode-ai/plugin` is there and fail the run. Installing first closes
// that race. `root` is the checkout OpenCode runs in.
export function openCodeConfigDirs(root: string, env = process.env): string[] {
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return Array.from(
    new Set([
      join(root, ".opencode"),
      join(configHome, "opencode"),
      ...(env.OPENCODE_CONFIG_DIR ? [env.OPENCODE_CONFIG_DIR] : []),
    ]),
  );
}

export type DependencyInstaller = (dir: string, frozenLockfile: boolean) => Promise<void>;

const INSTALL_TIMEOUT_MS = 2 * 60 * 1000;

// --no-save keeps a new lockfile out of the checkout, where a write-mode run
// could commit it.
export const bunInstall: DependencyInstaller = async (dir, frozenLockfile) => {
  const proc = Bun.spawn(["bun", "install", frozenLockfile ? "--frozen-lockfile" : "--no-save"], {
    cwd: dir,
    stdout: "ignore",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), INSTALL_TIMEOUT_MS);
  try {
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
    ]);
    if (exitCode !== 0) {
      throw new Error(`bun install exited with ${exitCode}: ${stderr.trim().slice(-2000)}`);
    }
  } finally {
    clearTimeout(timer);
  }
};

// Installs dependencies for each directory with a package.json and no
// node_modules. Never throws: OpenCode still tries its own install, so a
// failure here is only a warning.
export async function installOpenCodeDependencies(
  dirs: string[],
  install: DependencyInstaller = bunInstall,
): Promise<string[]> {
  const installed: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(join(dir, "package.json")) || existsSync(join(dir, "node_modules"))) continue;
    const frozen = existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"));
    try {
      await install(dir, frozen);
      installed.push(dir);
      core.info(`Installed OpenCode dependencies in ${dir}`);
    } catch (error) {
      core.warning(
        `Could not install OpenCode dependencies in ${dir}; OpenCode will try again: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return installed;
}

// Core utilities similar to @actions/core
export const core: Core = {
  info: (message: string) => {
    console.log(message);
  },
  warning: (message: string) => {
    console.log(`::warning::${message}`);
  },
  error: (message: string) => {
    console.log(`::error::${message}`);
  },
  setFailed: (message: string) => {
    console.log(`::error::${message}`);
    process.exit(1);
  },
  setOutput: (name: string, value: string) => {
    const outputFile = process.env.GITHUB_OUTPUT;
    if (outputFile) {
      appendGitHubValue(outputFile, name, value);
    }
  },
};

// Get OIDC token from GitHub Actions
export async function getOidcToken(audience: string = DEFAULT_OIDC_AUDIENCE): Promise<string> {
  const cached = oidcTokenCache.get(audience);
  if (cached) return cached;

  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!requestUrl || !requestToken) {
    throw new Error("OIDC token request credentials not available");
  }

  const tokenPromise = (async () => {
    const url = new URL(requestUrl);
    url.searchParams.set("audience", audience);

    const response = await fetchWithRetry(url.toString(), {
      headers: { Authorization: `bearer ${requestToken}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to get OIDC token: ${response.status}`);
    }

    const data = (await response.json()) as { value?: string };
    if (!data.value) {
      throw new Error("OIDC token response missing value");
    }

    return data.value;
  })();

  oidcTokenCache.set(audience, tokenPromise);
  try {
    return await tokenPromise;
  } catch (error) {
    oidcTokenCache.delete(audience);
    throw error;
  }
}

// Get API base URL from OIDC base URL
export function getApiBaseUrl(): string {
  const oidcBaseUrl = process.env.OIDC_BASE_URL;
  if (!oidcBaseUrl) {
    throw new Error("OIDC_BASE_URL not set");
  }
  if (oidcBaseUrl.includes("?") || oidcBaseUrl.includes("#")) {
    throw new Error("OIDC_BASE_URL must not include credentials, query, or fragment");
  }
  let url: URL;
  try {
    url = new URL(oidcBaseUrl);
  } catch {
    throw new Error("OIDC_BASE_URL must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("OIDC_BASE_URL must use https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("OIDC_BASE_URL must not include credentials, query, or fragment");
  }
  const normalized = url.toString().replace(/\/+$/, "");
  return normalized.replace(/\/auth$/, "");
}

// Neutralizes angle brackets so values cannot open or close Bonk's prompt tags.
export function escapePromptValue(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Shared fork detection from env vars and optional API fallback.
// Returns { isFork, headSha? } or null if detection failed.
export async function detectForkFromPR(
  headRepo: string | undefined,
  baseRepo: string | undefined,
  prUrl: string | undefined,
  ghToken: string | undefined,
): Promise<{ isFork: boolean; headSha?: string } | null> {
  // Deleted fork: base exists but head is missing
  if (baseRepo && !headRepo) {
    return { isFork: true };
  }
  // Both present: compare
  if (headRepo && baseRepo) {
    return { isFork: headRepo !== baseRepo };
  }
  // Fallback: fetch PR data from API
  if (!prUrl || !ghToken) return null;
  try {
    const resp = await fetchWithRetry(prUrl, {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!resp.ok) return null;
    const pr = (await resp.json()) as {
      head?: { repo?: { full_name?: string }; sha?: string };
      base?: { repo?: { full_name?: string } };
    };
    const head = pr.head?.repo?.full_name;
    const base = pr.base?.repo?.full_name;
    if (!base) {
      // Fail closed: if base metadata is missing, default to fork mode so the
      // workflow can continue safely in comment-only behavior.
      return { isFork: true, headSha: pr.head?.sha };
    }
    return { isFork: !head || head !== base, headSha: pr.head?.sha };
  } catch {
    return null;
  }
}

// Validates an OpenCode version string. Accepts "latest", "dev", or a semver-
// like version (e.g. "1.2.16", "1.2.16-beta.1"). Returns the validated version
// string, or "latest" for empty/invalid input.
const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;

export function validateOpenCodeVersion(input: string | undefined): string {
  const trimmed = input?.trim();
  if (!trimmed || trimmed === "latest" || trimmed === "dev") {
    return trimmed || "latest";
  }
  if (SEMVER_RE.test(trimmed)) {
    return trimmed;
  }
  return "latest";
}

// Checks whether the actual permission level meets the required level.
// Only 'admin' and 'write' are recognized as required levels; unrecognized
// levels return an error message. Returns null when the check passes.
const PERMISSION_RANK: Record<string, number> = { admin: 2, write: 1 };

export function checkPermissionLevel(
  actual: string,
  required: string,
  actor: string,
): string | null {
  const requiredRank = PERMISSION_RANK[required];
  if (requiredRank === undefined) {
    return `Unknown permission level: ${required}. Use 'admin', 'write', 'any', or 'CODEOWNERS'`;
  }
  if ((PERMISSION_RANK[actual] ?? 0) < requiredRank) {
    return `User ${actor} does not have ${required} permission (has: ${actual})`;
  }
  return null;
}

export function extractMentionPrompt(
  body: string | undefined,
  mentionsInput: string | undefined,
): string | null {
  const trimmed = body?.trim();
  if (!trimmed) return null;

  const mentions = (mentionsInput || "/bonk,@ask-bonk")
    .split(",")
    .map((mention) => mention.trim().toLowerCase())
    .filter(Boolean);
  if (mentions.length === 0) return null;

  const lower = trimmed.toLowerCase();
  if (mentions.some((mention) => lower === mention)) {
    return "Summarize this thread";
  }
  if (mentions.some((mention) => containsMention(lower, mention))) {
    return trimmed;
  }
  return null;
}

// A mention counts only as a whole token: at the start of the body or after
// whitespace, and followed by whitespace or the end, optionally after
// punctuation (`/bonk,` but not `/bonk.yml`). Paths such as
// `.github/workflows/bonk.yml`, which bots list in CODEOWNERS comments, and
// words that merely contain the mention do not trigger a run. Keep in sync
// with the "Check mentions" step in action.yml.
export function containsMention(body: string, mention: string): boolean {
  const escaped = mention.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?=[.,;:!?)\\]}'"]*(?:$|\\s))`, "i").test(body);
}

// Parses a TOKEN_PERMISSIONS input value (env var from action.yml).
// Returns the parsed value (preset name string or JSON object) or undefined
// for empty/whitespace/malformed input.
export function parseTokenPermissions(input: string | undefined): unknown {
  const trimmed = input?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  return trimmed;
}
