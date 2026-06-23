// Consolidated orchestrator for Bonk GitHub Action pre-flight steps.
//
// Consolidated from 7 separate bun invocations (permissions, setup, version,
// prompt, oidc-exchange, fork-comment, require-oidc, track) into a single process.
// Eliminates ~6 bun cold starts and enables parallelism between independent
// network calls (version, prompt, oidc-exchange run concurrently).
//
// Still executed via `bun run` — no pre-bundled dist/ needed.
// finalize.ts remains separate because it runs with `if: always()`.

import { readFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import {
  getContext,
  getOidcToken,
  getApiBaseUrl,
  detectForkFromPR,
  parseTokenPermissions,
  validateOpenCodeVersion,
  checkPermissionLevel,
  extractMentionPrompt,
  core,
} from "./context";
import { fetchWithRetry } from "./http";

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
const ESCAPED_CODEOWNERS_CHAR = "\u0000";

interface ContentResponse {
  content: string;
}

interface PullRequestFileResponse {
  filename: string;
  previous_filename?: string;
}

interface ChangedFilesResult {
  paths: string[];
  recordCount: number;
}

interface CodeownersCheckResult {
  teamGroups: string[][];
}

interface PullRequestResponse {
  changed_files?: number;
  base?: {
    ref?: string;
    sha?: string;
  };
}

interface CodeownersRule {
  pattern: string;
  owners: string[];
  teams: string[];
  unsupportedOwners: string[];
  unsupportedPattern: boolean;
}

async function githubApi<T>(path: string, token: string): Promise<T | null> {
  const resp = await fetchWithRetry(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!resp.ok) {
    if (resp.status === 404) return null;
    throw new Error(`GitHub API ${path} returned ${resp.status}: ${await resp.text()}`);
  }
  return (await resp.json()) as T;
}

export function parseCodeowners(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];

  for (const line of content.split("\n")) {
    const fields = splitCodeownersLine(line);
    if (fields.length < 1) continue;

    const owners: string[] = [];
    const teams: string[] = [];
    const unsupportedOwners: string[] = [];
    for (const ownerField of fields.slice(1)) {
      if (/^@[\w-]+(?:\/[\w-]+)?$/.test(ownerField)) {
        if (ownerField.includes("/")) {
          teams.push(ownerField.substring(1).toLowerCase());
        } else {
          owners.push(ownerField.substring(1).toLowerCase());
        }
      } else {
        unsupportedOwners.push(ownerField);
      }
    }

    rules.push({
      pattern: fields[0],
      owners,
      teams,
      unsupportedOwners,
      unsupportedPattern: hasUnsupportedCodeownersPattern(fields[0]),
    });
  }

  return rules;
}

function splitCodeownersLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let escaped = false;

  for (const char of line.trim()) {
    if (escaped) {
      current += `${ESCAPED_CODEOWNERS_CHAR}${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "#" && !current) break;
    if (/\s/.test(char)) {
      if (current) {
        fields.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";
  if (current) fields.push(current);
  return fields;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.*]/g, "\\$&");
}

function hasUnsupportedCodeownersPattern(pattern: string): boolean {
  if (pattern.startsWith("!")) return true;
  if (pattern.startsWith(`${ESCAPED_CODEOWNERS_CHAR}#`)) return true;
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === ESCAPED_CODEOWNERS_CHAR) {
      index += 1;
      continue;
    }
    if (pattern[index] === "[" || pattern[index] === "]") return true;
  }
  return false;
}

function hasLiteralDirectoryChars(segment: string): boolean {
  for (let index = 0; index < segment.length; index += 1) {
    if (segment[index] === ESCAPED_CODEOWNERS_CHAR) {
      index += 1;
      continue;
    }
    if (segment[index] !== "*" && segment[index] !== "?") return true;
  }
  return false;
}

function codeownersPatternToRegex(pattern: string): RegExp | null {
  if (!pattern || pattern.startsWith("!")) return null;

  const anchored = pattern.startsWith("/");
  const directoryPattern = pattern.endsWith("/");
  let normalized = pattern.replace(/^\/+/, "");
  if (!normalized) return null;
  const slashlessPattern = !normalized.replace(/\/+$/, "").includes("/");
  if (directoryPattern) normalized += "**";
  const finalSegment = normalized.split("/").at(-1) || "";
  const finalSegmentCanBeDirectory = hasLiteralDirectoryChars(finalSegment);
  const descendantMatch =
    !directoryPattern && (!/[*?]/.test(finalSegment) || finalSegmentCanBeDirectory);
  const anyParentPrefix =
    !anchored && (slashlessPattern || normalized.startsWith("**/"));

  let source = "";
  for (let index = 0; index < normalized.length; ) {
    if (normalized[index] === ESCAPED_CODEOWNERS_CHAR) {
      const escapedChar = normalized[index + 1] || "";
      source += escapeRegex(escapedChar);
      index += escapedChar ? 2 : 1;
      continue;
    }
    if (normalized.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (normalized.startsWith("**", index) && index + 2 === normalized.length && normalized[index - 1] === "/") {
      source += ".*";
      index += 2;
      continue;
    }
    const char = normalized[index];
    if (char === "*") {
      source += "[^/]*";
      index += 1;
    } else if (char === "?") {
      source += "[^/]";
      index += 1;
    } else {
      source += escapeRegex(char);
      index += 1;
    }
  }

  source = anyParentPrefix ? `(?:^|.*/)${source}` : `^${source}`;
  if (descendantMatch) source += "(?:/.*)?";
  return new RegExp(`${source}$`);
}

export function findMatchingCodeownersRule(
  rules: CodeownersRule[],
  filename: string,
): CodeownersRule | null {
  let matched: CodeownersRule | null = null;
  for (const rule of rules) {
    const regex = codeownersPatternToRegex(rule.pattern);
    if (regex?.test(filename)) {
      matched = rule;
    }
  }
  return matched;
}

async function listChangedFiles(
  owner: string,
  repo: string,
  prNumber: string,
  token: string,
): Promise<ChangedFilesResult> {
  const filenames = new Set<string>();
  let recordCount = 0;
  for (let page = 1; ; page += 1) {
    const files = await githubApi<PullRequestFileResponse[]>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      token,
    );
    if (!files) return { paths: [], recordCount: 0 };
    recordCount += files.length;
    for (const file of files) {
      if (file.filename) filenames.add(file.filename);
      if (file.previous_filename) filenames.add(file.previous_filename);
    }
    if (files.length < 100) break;
  }
  return { paths: Array.from(filenames), recordCount };
}

async function actorHasWritePermission(
  owner: string,
  repo: string,
  actor: string,
  token: string,
): Promise<boolean> {
  const data = await githubApi<{ permission: string }>(
    `/repos/${owner}/${repo}/collaborators/${actor}/permission`,
    token,
  );
  return Boolean(data && !checkPermissionLevel(data.permission, "write", actor));
}

function actorOwnsRule(rule: CodeownersRule, actor: string): boolean {
  const actorLower = actor.toLowerCase();
  return rule.owners.includes(actorLower);
}

export async function checkCodeowners(
  owner: string,
  repo: string,
  ref: string,
  actor: string,
  token: string,
): Promise<CodeownersCheckResult> {
  const prNumber = process.env.PR_NUMBER || process.env.ISSUE_NUMBER || "";
  if (!prNumber) {
    return core.setFailed("CODEOWNERS permission requires pull request context");
  }

  const pr = await githubApi<PullRequestResponse>(`/repos/${owner}/${repo}/pulls/${prNumber}`, token);
  const codeownersRef = pr?.base?.sha || pr?.base?.ref;
  if (!pr || !codeownersRef) {
    return core.setFailed("CODEOWNERS permission could not determine PR base ref");
  }

  let codeownersContent = "";
  let codeownersFound = false;

  for (const path of CODEOWNERS_PATHS) {
    const data = await githubApi<ContentResponse>(
      `/repos/${owner}/${repo}/contents/${path}?ref=${codeownersRef || ref || "HEAD"}`,
      token,
    );
    if (data) {
      codeownersFound = true;
      codeownersContent = data.content
        ? Buffer.from(data.content, "base64").toString("utf8")
        : "";
      core.info(`Found CODEOWNERS at ${path}`);
      break;
    }
  }

  if (!codeownersFound) {
    return core.setFailed("CODEOWNERS file not found in .github/, root, or docs/ directory");
  }

  const rules = parseCodeowners(codeownersContent);
  if (rules.some((rule) => rule.unsupportedPattern)) {
    return core.setFailed("CODEOWNERS file contains unsupported pattern syntax");
  }
  const changedFiles = await listChangedFiles(owner, repo, prNumber, token);
  if (changedFiles.paths.length === 0) {
    return core.setFailed("CODEOWNERS permission could not determine changed PR files");
  }
  if (pr.changed_files !== undefined && pr.changed_files > changedFiles.recordCount) {
    return core.setFailed("CODEOWNERS permission could not inspect every changed PR file");
  }

  let hasWritePermission: boolean | undefined;
  const teamGroups: string[][] = [];
  const teamGroupKeys = new Set<string>();
  for (const filename of changedFiles.paths) {
    const rule = findMatchingCodeownersRule(rules, filename);
    if (!rule) {
      return core.setFailed(`No CODEOWNERS rule matched changed file ${filename}`);
    }
    if (rule.unsupportedOwners.length > 0) {
      return core.setFailed(`Unsupported CODEOWNERS owner for changed file ${filename}`);
    }
    hasWritePermission ??= await actorHasWritePermission(owner, repo, actor, token);
    if (rule.owners.length === 0 && rule.teams.length === 0) {
      if (!hasWritePermission) {
        return core.setFailed(`Ownerless CODEOWNERS rule for ${filename} requires write permission`);
      }
      continue;
    }
    if (!hasWritePermission) {
      return core.setFailed(`User ${actor} must have write permission to satisfy CODEOWNERS`);
    }
    if (actorOwnsRule(rule, actor)) {
      continue;
    }
    if (rule.teams.length > 0) {
      const teamGroupKey = rule.teams.join("\0");
      if (!teamGroupKeys.has(teamGroupKey)) {
        teamGroupKeys.add(teamGroupKey);
        teamGroups.push(rule.teams);
      }
      continue;
    }
    if (!actorOwnsRule(rule, actor)) {
      return core.setFailed(`User ${actor} is not a CODEOWNER for changed file ${filename}`);
    }
  }

  if (teamGroups.length > 0) {
    core.info(`User ${actor} requires server-side CODEOWNERS team verification`);
  } else {
    core.info(`User ${actor} is a code owner for all changed files`);
  }
  return { teamGroups };
}

async function checkPermissions(): Promise<CodeownersCheckResult | null> {
  const requiredPermission = process.env.REQUIRED_PERMISSION;
  if (!requiredPermission) {
    return core.setFailed("REQUIRED_PERMISSION not set");
  }
  if (requiredPermission === "any") return null;

  const token = process.env.GH_TOKEN;
  if (!token) {
    return core.setFailed("GH_TOKEN not set");
  }

  const repository = process.env.GITHUB_REPOSITORY || "";
  const [owner = "", repo = ""] = repository.split("/");
  const actor =
    process.env.COMMENT_ACTOR || process.env.REVIEW_ACTOR || process.env.GITHUB_ACTOR || "";
  const ref = process.env.DEFAULT_BRANCH || "main";

  if (!owner || !repo || !actor) {
    return core.setFailed("Missing required context (owner, repo, or actor)");
  }

  if (requiredPermission === "CODEOWNERS") {
    return checkCodeowners(owner, repo, ref, actor, token);
  }

  const data = await githubApi<{ permission: string }>(
    `/repos/${owner}/${repo}/collaborators/${actor}/permission`,
    token,
  );

  if (!data) {
    return core.setFailed(`Could not check permission for ${actor}`);
  }

  const error = checkPermissionLevel(data.permission, requiredPermission, actor);
  if (error) {
    core.setFailed(error);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Setup — returns true if we should skip remaining steps
// ---------------------------------------------------------------------------

interface SetupResponse {
  exists: boolean;
  prUrl?: string;
  error?: string;
}

async function checkSetup(): Promise<boolean> {
  const context = getContext();
  const { owner, repo } = context.repo;
  const issueNumber = context.issue?.number;
  const defaultBranch = context.defaultBranch;
  const eventName = process.env.EVENT_NAME || "";

  if (!issueNumber) {
    if (
      eventName === "pull_request" ||
      eventName === "pull_request_review" ||
      eventName === "pull_request_review_comment" ||
      eventName === "issue_comment" ||
      eventName === "issues"
    ) {
      return core.setFailed("No issue number found for PR/issue event; cannot run setup check");
    }
    core.info("No issue number found, skipping setup check");
    core.setOutput("skip", "false");
    return false;
  }

  let oidcToken: string;
  try {
    oidcToken = await getOidcToken();
  } catch (error) {
    const oidcAvailable =
      !!process.env.ACTIONS_ID_TOKEN_REQUEST_URL && !!process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (oidcAvailable) {
      return core.setFailed(`OIDC token exchange failed unexpectedly: ${error}`);
    }
    core.warning("OIDC not available, skipping setup check");
    core.setOutput("skip", "false");
    return false;
  }

  const apiBase = getApiBaseUrl();
  const setupUrl = `${apiBase}/api/github/setup`;
  const setupTimeoutMs = 4000;
  const setupRetries = 2;
  const setupBaseDelayMs = 1000;

  core.info(`Checking setup for ${owner}/${repo}#${issueNumber}`);

  let response: Response;
  try {
    response = await fetchWithRetry(
      setupUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${oidcToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          owner,
          repo,
          issue_number: issueNumber,
          default_branch: defaultBranch,
        }),
      },
      {
        timeoutMs: setupTimeoutMs,
        retries: setupRetries,
        baseDelayMs: setupBaseDelayMs,
        onRetry: ({ attempt, maxAttempts, delayMs, statusCode, error }) => {
          const reason = statusCode !== undefined ? `status ${statusCode}` : error;
          core.warning(
            `Setup check retry ${attempt}/${maxAttempts} in ${delayMs}ms (${reason || "unknown error"})`,
          );
        },
      },
    );
  } catch (error) {
    return core.setFailed(`Setup request failed after ${setupRetries + 1} attempts: ${error}`);
  }

  core.info(`Setup check completed with status ${response.status}`);

  if (!response.ok) {
    const text = await response.text();
    return core.setFailed(`Setup request failed: ${text}`);
  }

  const data = (await response.json()) as SetupResponse;

  if (data.error) {
    return core.setFailed(`Setup failed: ${data.error}`);
  }

  if (data.exists) {
    core.info("Workflow file exists");
    core.setOutput("skip", "false");
    return false;
  }

  core.info(`Workflow file missing - PR created: ${data.prUrl}`);
  core.setOutput("skip", "true");
  core.setOutput("pr_url", data.prUrl || "");
  return true;
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

function resolveVersion(): void {
  const isDev = process.env.OPENCODE_DEV === "true";
  core.setOutput("dev", isDev ? "true" : "false");

  const rawVersion = process.env.OPENCODE_VERSION;
  const resolvedVersion = validateOpenCodeVersion(rawVersion);
  if (rawVersion && rawVersion.trim() !== resolvedVersion && resolvedVersion === "latest") {
    core.warning(
      `Invalid opencode_version "${rawVersion}" — falling back to "latest". Use a semver string (e.g. "1.2.16") or "latest".`,
    );
  }
  core.setOutput("opencode_version", resolvedVersion);
  core.info(`Resolved opencode version: ${resolvedVersion}`);
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

interface ForkDetectionResult {
  isFork: boolean;
  headSha?: string;
  detectionFailed?: boolean;
}

async function detectFork(): Promise<ForkDetectionResult> {
  const eventName = process.env.EVENT_NAME;
  const ghToken = process.env.GH_TOKEN;

  switch (eventName) {
    case "pull_request":
    case "pull_request_review_comment":
    case "pull_request_review": {
      const result = await detectForkFromPR(
        process.env.PR_HEAD_REPO,
        process.env.PR_BASE_REPO,
        process.env.PR_URL,
        ghToken,
      );
      if (!result) {
        core.warning("Fork detection failed for PR event");
        return { isFork: false, detectionFailed: true };
      }
      return result;
    }

    case "issue_comment": {
      const prNumber = process.env.PR_NUMBER;
      const repository = process.env.REPOSITORY;
      if (!prNumber || !repository) return { isFork: false };
      if (!ghToken) {
        core.warning("Fork detection failed: missing GH_TOKEN");
        return { isFork: false, detectionFailed: true };
      }
      const prUrl = `https://api.github.com/repos/${repository}/pulls/${prNumber}`;
      const result = await detectForkFromPR(undefined, undefined, prUrl, ghToken);
      if (!result) {
        core.warning("Fork detection failed for issue_comment event");
        return { isFork: false, detectionFailed: true };
      }
      return result;
    }

    default:
      return { isFork: false };
  }
}

async function resolveHeadSha(
  prNumber: string,
  repository: string,
  cachedSha?: string,
): Promise<string> {
  const envSha = process.env.HEAD_SHA;
  if (envSha) return envSha;
  if (cachedSha) return cachedSha;

  const ghToken = process.env.GH_TOKEN;
  if (!prNumber || !repository || !ghToken) return "";

  try {
    const resp = await fetchWithRetry(
      `https://api.github.com/repos/${repository}/pulls/${prNumber}`,
      {
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (!resp.ok) return "";
    const pr = (await resp.json()) as { head?: { sha?: string } };
    return pr.head?.sha || "";
  } catch {
    // Best-effort: HEAD SHA is used for fork guidance context only.
    // Missing SHA means inline review comments may not anchor correctly,
    // but the workflow can still proceed.
    return "";
  }
}

function buildForkGuidance(prNumber: string, owner: string, repo: string, headSha: string): string {
  const actionPath = process.env.ACTION_PATH;
  if (!actionPath) {
    core.warning("ACTION_PATH not set, using minimal fork guidance");
    return `This PR is from a fork. You are in comment-only mode for PR #${prNumber} in ${owner}/${repo}. Do not attempt git write operations.`;
  }

  let guidance: string;
  try {
    guidance = readFileSync(join(actionPath, "fork_guidance.md"), "utf-8");
  } catch (error) {
    core.warning(`Could not read fork_guidance.md: ${error}`);
    return `This PR is from a fork. You are in comment-only mode for PR #${prNumber} in ${owner}/${repo}. Do not attempt git write operations.`;
  }

  if (!headSha) {
    core.warning("Could not resolve HEAD SHA for fork PR; inline review comments may fail");
  }

  guidance = guidance.replace(/\{\{PR_NUMBER\}\}/g, prNumber);
  guidance = guidance.replace(/\{\{OWNER\}\}/g, owner);
  guidance = guidance.replace(/\{\{REPO\}\}/g, repo);
  guidance = guidance.replace(/\{\{HEAD_SHA\}\}/g, headSha || "UNKNOWN");

  return guidance.trim();
}

interface PromptResult {
  isFork: boolean;
  detectionFailed: boolean;
  value: string;
}

export async function buildPrompt(): Promise<PromptResult> {
  const detection = await detectFork();

  const parts: string[] = [];

  const prNumber = process.env.ISSUE_NUMBER || process.env.PR_NUMBER || "";
  const repository = process.env.REPOSITORY || "";
  const [owner = "", repo = ""] = repository.split("/");

  if (detection.isFork) {
    const headSha = await resolveHeadSha(prNumber, repository, detection.headSha);

    if (!prNumber || !owner || !repo) {
      core.warning("Cannot determine PR context for fork guidance; using minimal guidance");
      parts.push(
        "This PR is from a fork. You are in comment-only mode. Do not attempt git write operations.",
      );
    } else {
      parts.push(buildForkGuidance(prNumber, owner, repo, headSha));
    }

    core.info("PR is from a fork. Fork guidance prompt built.");
  } else if (process.env.PR_NUMBER && owner && repo) {
    // Prevent the model from inferring a stale PR from git state.
    // See: https://github.com/ask-bonk/ask-bonk/issues/148
    parts.push(
      `You are working on PR #${process.env.PR_NUMBER} in ${owner}/${repo}. When posting reviews or comments, always target PR #${process.env.PR_NUMBER}.`,
    );
    core.info(`Non-fork PR context set: ${owner}/${repo}#${process.env.PR_NUMBER}`);
  }

  const userPrompt = process.env.USER_PROMPT?.trim();
  if (userPrompt) {
    parts.push(userPrompt);
  } else {
    const commentPrompt = extractMentionPrompt(
      process.env.COMMENT_BODY || process.env.REVIEW_BODY,
      process.env.MENTIONS,
    );
    if (commentPrompt) {
      parts.push(commentPrompt);
    }
  }

  return {
    isFork: detection.isFork,
    detectionFailed: detection.detectionFailed ?? false,
    value: parts.join("\n\n"),
  };
}

// ---------------------------------------------------------------------------
// OIDC Exchange
// ---------------------------------------------------------------------------

interface OidcResult {
  failed: boolean;
  token?: string;
}

interface OidcExchangeOptions {
  forceNoPush: boolean;
  codeownersTeamGroups?: string[][];
}

function maskValue(value: string): void {
  if (value) {
    console.log(`::add-mask::${value}`);
  }
}

function oidcFailClosed(reason: string): OidcResult {
  core.warning(`OIDC exchange failed: ${reason}`);
  return { failed: true };
}

async function exchangeOidc(options: OidcExchangeOptions): Promise<OidcResult> {
  const oidcUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const oidcRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!oidcUrl || !oidcRequestToken) {
    return oidcFailClosed("OIDC credentials not available");
  }

  let actionOidcToken: string;
  try {
    actionOidcToken = await getOidcToken();
  } catch (error) {
    return oidcFailClosed(`Failed to get OIDC token: ${error}`);
  }

  let oidcBaseUrl: string;
  try {
    oidcBaseUrl = `${getApiBaseUrl()}/auth`;
  } catch (error) {
    return oidcFailClosed(`Invalid OIDC_BASE_URL: ${error}`);
  }

  // Build request body — include token_permissions if provided by the caller.
  // Accepts a preset name (e.g., "NO_PUSH") or a JSON permissions object.
  const exchangeBody: Record<string, unknown> = {};
  const rawPermissions = process.env.TOKEN_PERMISSIONS;
  if (options.forceNoPush) {
    exchangeBody.permissions = "NO_PUSH";
  } else if (rawPermissions?.trim()) {
    const parsed = parseTokenPermissions(rawPermissions);
    if (parsed !== undefined) {
      exchangeBody.permissions = parsed;
    } else {
      // parseTokenPermissions returns undefined only for malformed JSON (the
      // outer `if` already guarantees the input is non-empty after trim).
      // Fail closed: send NO_PUSH so the server doesn't grant full defaults.
      core.warning(`Invalid TOKEN_PERMISSIONS JSON, falling back to NO_PUSH: ${rawPermissions}`);
      exchangeBody.permissions = "NO_PUSH";
    }
  }

  if (options.codeownersTeamGroups && options.codeownersTeamGroups.length > 0) {
    exchangeBody.codeowners_team_groups = options.codeownersTeamGroups;
    const actor = process.env.COMMENT_ACTOR || process.env.REVIEW_ACTOR || process.env.GITHUB_ACTOR;
    if (actor) {
      exchangeBody.actor = actor;
    }
  }

  let appToken: string;
  try {
    const resp = await fetchWithRetry(
      `${oidcBaseUrl}/exchange_github_app_token`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${actionOidcToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(exchangeBody),
      },
      { timeoutMs: 10000 },
    );

    if (!resp.ok) {
      const text = await resp.text();
      let errorMessage = "Unknown error";
      try {
        const data = JSON.parse(text) as { error?: string };
        errorMessage = data.error || errorMessage;
      } catch {
        errorMessage = text || errorMessage;
      }
      return oidcFailClosed(`Token exchange returned ${resp.status}: ${errorMessage}`);
    }

    const data = (await resp.json()) as { token?: string };
    if (!data.token) {
      return oidcFailClosed("Token exchange response missing token");
    }
    appToken = data.token;
  } catch (error) {
    return oidcFailClosed(`Token exchange request failed: ${error}`);
  }

  maskValue(appToken);
  return { failed: false, token: appToken };
}

// ---------------------------------------------------------------------------
// Fork Comment
// ---------------------------------------------------------------------------

const FORK_COMMENT_MARKER = "<!-- bonk-fork-unsupported -->";

async function handleFork(oidcFailed: boolean): Promise<void> {
  const forksEnabled = process.env.FORKS !== "false";
  if (!forksEnabled) {
    core.info("Fork PR detected but forks input is disabled. Skipping silently.");
    return;
  }

  if (!oidcFailed) {
    core.info("Fork PR with OIDC token available. OpenCode will run in comment-only mode.");
    core.setOutput("run_opencode", "true");
    return;
  }

  // OIDC failed — post a "not supported" comment if we can.
  const repository = process.env.REPOSITORY;
  const issueNumber = process.env.ISSUE_NUMBER;
  const actor = process.env.ACTOR;
  const ghToken = process.env.GH_TOKEN;

  if (!repository || !issueNumber || !ghToken) {
    core.warning(
      "OIDC unavailable for fork PR and missing context to post comment. " +
        "This is expected when GitHub restricts id-token permissions for fork workflow runs.",
    );
    return;
  }

  // Check for duplicate comments
  try {
    const resp = await fetchWithRetry(
      `https://api.github.com/repos/${repository}/issues/${issueNumber}/comments?per_page=100&direction=desc`,
      {
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (resp.ok) {
      const comments = (await resp.json()) as Array<{ body?: string }>;
      if (comments.some((c) => c.body?.includes(FORK_COMMENT_MARKER))) {
        core.info("Fork unsupported comment already posted.");
        return;
      }
    }
  } catch {
    // Dedup check is best-effort — if the API call fails (e.g., transient
    // network error), proceed to post. Worst case is a duplicate comment.
  }

  const mention = actor ? `@${actor} ` : "";
  const body =
    `${FORK_COMMENT_MARKER}\n` +
    `${mention}bonk can't run on pull requests from forks due to ` +
    `[GitHub Actions permission restrictions](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect).`;

  try {
    const resp = await fetchWithRetry(
      `https://api.github.com/repos/${repository}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({ body }),
      },
    );

    if (resp.ok) {
      core.info("Posted fork unsupported comment.");
    } else {
      core.warning(`Failed to post fork comment (${resp.status}). Token may be read-only.`);
    }
  } catch (error) {
    core.warning(`Failed to post fork comment: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// Track
// ---------------------------------------------------------------------------

interface TrackPayload {
  owner: string;
  repo: string;
  run_id: number;
  run_url: string;
  issue_number: number;
  created_at: string;
  comment_id?: number;
  review_comment_id?: number;
  issue_id?: number;
}

interface TrackResponse {
  ok?: boolean;
  error?: string;
}

async function trackRun(): Promise<void> {
  const context = getContext();
  const { owner, repo } = context.repo;

  if (!context.issue?.number) {
    core.info("No issue number found, skipping tracking");
    return;
  }

  let oidcToken: string;
  try {
    oidcToken = await getOidcToken();
  } catch (error) {
    core.warning(`Failed to get OIDC token: ${error}`);
    return;
  }

  const apiBase = getApiBaseUrl();

  const payload: TrackPayload = {
    owner,
    repo,
    run_id: context.runId,
    run_url: context.runUrl,
    issue_number: context.issue.number,
    created_at: context.createdAt,
  };

  if (context.eventName === "issue_comment" && context.comment?.id) {
    payload.comment_id = context.comment.id;
  } else if (context.eventName === "pull_request_review_comment" && context.comment?.id) {
    payload.review_comment_id = context.comment.id;
  } else if (context.eventName === "issues") {
    payload.issue_id = context.issue.number;
  }

  let response: Response;
  try {
    response = await fetchWithRetry(`${apiBase}/api/github/track`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    core.warning(`Failed to track Bonk run: ${error}`);
    return;
  }

  if (!response.ok) {
    const text = await response.text();
    core.warning(`Failed to track Bonk run: ${text}`);
    return;
  }

  const data = (await response.json()) as TrackResponse;

  if (data.error) {
    core.warning(`Track failed: ${data.error}`);
    return;
  }

  core.info(`Successfully started tracking run ${context.runId}`);
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

async function main() {
  // Step 1: Check permissions (must pass before anything else)
  const codeownersCheck = await checkPermissions();

  // Step 2: Check setup (may skip remaining steps)
  const shouldSkip = await checkSetup();
  if (shouldSkip) return;

  // Step 3: Resolve version, then build the prompt before exchanging the token
  // so fork runs can request a comment-only installation token.
  resolveVersion();

  const promptResult = await buildPrompt();

  if (promptResult.detectionFailed) {
    core.setOutput("is_fork", String(promptResult.isFork));
    core.setOutput("value", promptResult.value);
    return core.setFailed("Fork status could not be verified; refusing to proceed.");
  }

  const oidcResult = await exchangeOidc({
    forceNoPush: promptResult.isFork,
    codeownersTeamGroups: codeownersCheck?.teamGroups,
  });

  // Set prompt outputs
  core.setOutput("is_fork", String(promptResult.isFork));
  core.setOutput("value", promptResult.value);
  core.setOutput("oidc_failed", oidcResult.failed ? "true" : "false");
  if (oidcResult.token) {
    core.setOutput("gh_token", oidcResult.token);
  }

  // Step 4: Handle fork PRs
  if (promptResult.isFork) {
    await handleFork(oidcResult.failed);
    return;
  }

  // Step 5: Require OIDC for non-fork runs
  if (oidcResult.failed) {
    return core.setFailed("OIDC token exchange failed. Ensure id-token: write is configured.");
  }

  // Step 6: Track the run
  await trackRun();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    core.setFailed(`Orchestrator failed: ${error}`);
  });
}
