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
import { getContext, getOidcToken, getApiBaseUrl, detectForkFromPR, core } from "./context";
import { fetchWithRetry } from "./http";

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

interface ContentResponse {
  content: string;
}

interface TeamMembershipResponse {
  state?: string;
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

function parseCodeowners(content: string): {
  owners: Set<string>;
  teamPatterns: string[];
} {
  const owners = new Set<string>();
  const teamPatterns: string[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const mentions = trimmed.match(/@[\w-]+(?:\/[\w-]+)?/g) || [];
    for (const mention of mentions) {
      if (mention.includes("/")) {
        teamPatterns.push(mention.substring(1));
      } else {
        owners.add(mention.substring(1).toLowerCase());
      }
    }
  }

  return { owners, teamPatterns };
}

async function checkCodeowners(
  owner: string,
  repo: string,
  ref: string,
  actor: string,
  token: string,
): Promise<void> {
  let codeownersContent = "";

  for (const path of CODEOWNERS_PATHS) {
    const data = await githubApi<ContentResponse>(
      `/repos/${owner}/${repo}/contents/${path}?ref=${ref || "HEAD"}`,
      token,
    );
    if (data?.content) {
      codeownersContent = Buffer.from(data.content, "base64").toString("utf8");
      core.info(`Found CODEOWNERS at ${path}`);
      break;
    }
  }

  if (!codeownersContent) {
    return core.setFailed("CODEOWNERS file not found in .github/, root, or docs/ directory");
  }

  const { owners, teamPatterns } = parseCodeowners(codeownersContent);
  const actorLower = actor.toLowerCase();

  if (owners.has(actorLower)) {
    core.info(`User ${actor} is a code owner`);
    return;
  }

  for (const teamPath of teamPatterns) {
    const [org, team] = teamPath.split("/");
    try {
      const membership = await githubApi<TeamMembershipResponse>(
        `/orgs/${org}/teams/${team}/memberships/${actor}`,
        token,
      );
      if (membership) {
        core.info(`User ${actor} is a member of team @${teamPath}`);
        return;
      }
    } catch (e) {
      const error = e as Error & { message?: string };
      core.warning(`Could not check team membership for @${teamPath}: ${error.message}`);
    }
  }

  core.setFailed(`User ${actor} is not listed in CODEOWNERS`);
}

async function checkPermissions(): Promise<void> {
  const requiredPermission = process.env.REQUIRED_PERMISSION;
  if (!requiredPermission) {
    return core.setFailed("REQUIRED_PERMISSION not set");
  }
  if (requiredPermission === "any") return;

  const token = process.env.GH_TOKEN;
  if (!token) {
    return core.setFailed("GH_TOKEN not set");
  }

  const repository = process.env.GITHUB_REPOSITORY || "";
  const [owner = "", repo = ""] = repository.split("/");
  const actor =
    process.env.COMMENT_ACTOR || process.env.REVIEW_ACTOR || process.env.GITHUB_ACTOR || "";
  const ref = process.env.GITHUB_REF || "HEAD";

  if (!owner || !repo || !actor) {
    return core.setFailed("Missing required context (owner, repo, or actor)");
  }

  if (requiredPermission === "CODEOWNERS") {
    await checkCodeowners(owner, repo, ref, actor, token);
    return;
  }

  const data = await githubApi<{ permission: string }>(
    `/repos/${owner}/${repo}/collaborators/${actor}/permission`,
    token,
  );

  if (!data) {
    return core.setFailed(`Could not check permission for ${actor}`);
  }

  const permission = data.permission;

  if (requiredPermission === "admin") {
    if (permission !== "admin") {
      core.setFailed(`User ${actor} does not have admin permission (has: ${permission})`);
    }
  } else if (requiredPermission === "write") {
    if (permission !== "admin" && permission !== "write") {
      core.setFailed(`User ${actor} does not have write permission (has: ${permission})`);
    }
  } else {
    core.setFailed(
      `Unknown permission level: ${requiredPermission}. Use 'admin', 'write', 'any', or 'CODEOWNERS'`,
    );
  }
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
      core.setFailed("No issue number found for PR/issue event; cannot run setup check");
      // core.setFailed calls process.exit(1), but TypeScript doesn't know that
      return true;
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
      core.setFailed(`OIDC token exchange failed unexpectedly: ${error}`);
      return true;
    }
    core.warning("OIDC not available, skipping setup check");
    core.setOutput("skip", "false");
    return false;
  }

  const apiBase = getApiBaseUrl();

  let response: Response;
  try {
    response = await fetchWithRetry(`${apiBase}/api/github/setup`, {
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
    });
  } catch (error) {
    core.setFailed(`Setup request failed: ${error}`);
    return true;
  }

  if (!response.ok) {
    const text = await response.text();
    core.setFailed(`Setup request failed: ${text}`);
    return true;
  }

  const data = (await response.json()) as SetupResponse;

  if (data.error) {
    core.setFailed(`Setup failed: ${data.error}`);
    return true;
  }

  if (data.exists) {
    core.info("Workflow file exists");
    core.setOutput("skip", "false");
    return false;
  } else {
    core.info(`Workflow file missing - PR created: ${data.prUrl}`);
    core.setOutput("skip", "true");
    core.setOutput("pr_url", data.prUrl || "");
    return true;
  }
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

const OPENCODE_REPO = "anomalyco/opencode";

async function resolveVersion(): Promise<void> {
  const isDev = process.env.OPENCODE_DEV === "true";
  const ghToken = process.env.GH_TOKEN || "";
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  if (ghToken) {
    headers.Authorization = `Bearer ${ghToken}`;
  }

  if (isDev) {
    let version = "dev";
    try {
      const resp = await fetchWithRetry(
        `https://api.github.com/repos/${OPENCODE_REPO}/commits/dev`,
        { headers },
      );
      if (resp.ok) {
        const data = (await resp.json()) as { sha?: string };
        if (data.sha) {
          version = data.sha.slice(0, 7);
        }
      }
    } catch {
      // Fall back to "dev" if the API is unavailable
    }
    core.setOutput("version", `dev-${version}`);
    core.setOutput("dev", "true");
    core.setOutput("cacheable", "true");
  } else {
    let version = "latest";
    try {
      const resp = await fetchWithRetry(
        `https://api.github.com/repos/${OPENCODE_REPO}/releases/latest`,
        { headers },
      );
      if (resp.ok) {
        const data = (await resp.json()) as { tag_name?: string };
        if (data.tag_name) {
          version = data.tag_name;
        }
      }
    } catch {
      // Fall back to "latest" if the API is unavailable
    }
    core.setOutput("version", version);
    core.setOutput("dev", "false");
    core.setOutput("cacheable", version !== "latest" ? "true" : "false");
  }
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

function resolvePRNumber(): string {
  return process.env.ISSUE_NUMBER || process.env.PR_NUMBER || "";
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

async function buildPrompt(): Promise<PromptResult> {
  const detection = await detectFork();

  const parts: string[] = [];

  if (detection.isFork) {
    const prNumber = resolvePRNumber();
    const repository = process.env.REPOSITORY || "";
    const [owner = "", repo = ""] = repository.split("/");
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
  }

  const userPrompt = process.env.USER_PROMPT;
  if (userPrompt) {
    parts.push(userPrompt);
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
}

function maskValue(value: string): void {
  if (value) {
    console.log(`::add-mask::${value}`);
  }
}

function appendToGithubEnv(name: string, value: string): void {
  const envFile = process.env.GITHUB_ENV;
  if (!envFile) {
    core.warning("GITHUB_ENV not set; cannot export environment variable");
    return;
  }
  const fs = require("fs");
  if (value.includes("\n")) {
    const delimiter = `BONK_${crypto.randomUUID().replace(/-/g, "")}`;
    fs.appendFileSync(envFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  } else {
    fs.appendFileSync(envFile, `${name}=${value}\n`);
  }
}

function oidcFailWithFallback(reason: string): OidcResult {
  const fallbackToken = process.env.FALLBACK_TOKEN || "";
  core.warning(`OIDC exchange failed: ${reason}`);
  maskValue(fallbackToken);
  appendToGithubEnv("GH_TOKEN", fallbackToken);
  return { failed: true };
}

async function exchangeOidc(): Promise<OidcResult> {
  const oidcUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const oidcRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!oidcUrl || !oidcRequestToken) {
    return oidcFailWithFallback("OIDC credentials not available (expected for fork PRs)");
  }

  let actionOidcToken: string;
  try {
    actionOidcToken = await getOidcToken();
  } catch (error) {
    return oidcFailWithFallback(`Failed to get OIDC token: ${error}`);
  }

  const rawOidcBaseUrl = process.env.OIDC_BASE_URL;
  if (!rawOidcBaseUrl) {
    return oidcFailWithFallback("OIDC_BASE_URL not set");
  }
  const oidcBaseUrl = rawOidcBaseUrl.replace(/\/+$/, "");

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
      return oidcFailWithFallback(`Token exchange returned ${resp.status}: ${errorMessage}`);
    }

    const data = (await resp.json()) as { token?: string };
    if (!data.token) {
      return oidcFailWithFallback("Token exchange response missing token");
    }
    appToken = data.token;
  } catch (error) {
    return oidcFailWithFallback(`Token exchange request failed: ${error}`);
  }

  maskValue(appToken);
  appendToGithubEnv("GH_TOKEN", appToken);
  return { failed: false };
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
    // If dedup check fails, proceed to post
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

  switch (context.eventName) {
    case "issue_comment":
      if (context.comment?.id) {
        payload.comment_id = context.comment.id;
      }
      break;
    case "pull_request_review_comment":
      if (context.comment?.id) {
        payload.review_comment_id = context.comment.id;
      }
      break;
    case "issues":
      if (context.issue?.number) {
        payload.issue_id = context.issue.number;
      }
      break;
    case "pull_request":
      break;
    case "pull_request_review":
      break;
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
  await checkPermissions();

  // Step 2: Check setup (may skip remaining steps)
  const shouldSkip = await checkSetup();
  if (shouldSkip) return;

  // Step 3: Run version, prompt, and OIDC exchange in parallel
  // These three are independent of each other.
  const [, promptResult, oidcResult] = await Promise.all([
    resolveVersion().catch((error) => {
      core.warning(`Failed to get opencode version: ${error}`);
      core.setOutput("version", process.env.OPENCODE_DEV === "true" ? "dev-dev" : "latest");
      core.setOutput("dev", process.env.OPENCODE_DEV === "true" ? "true" : "false");
      core.setOutput("cacheable", "false");
    }),
    buildPrompt(),
    exchangeOidc(),
  ]);

  // Set prompt outputs
  core.setOutput("is_fork", String(promptResult.isFork));
  core.setOutput("value", promptResult.value);
  core.setOutput("oidc_failed", oidcResult.failed ? "true" : "false");

  if (promptResult.detectionFailed) {
    core.setFailed("Fork status could not be verified; refusing to proceed.");
    return;
  }

  // Step 4: Handle fork PRs
  if (promptResult.isFork) {
    await handleFork(oidcResult.failed);
    return;
  }

  // Step 5: Require OIDC for non-fork runs
  if (oidcResult.failed) {
    core.setFailed("OIDC token exchange failed. Ensure id-token: write is configured.");
    return;
  }

  // Step 6: Track the run
  await trackRun();
}

main().catch((error) => {
  core.setFailed(`Orchestrator failed: ${error}`);
});
