import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// github/script/http.ts
var DEFAULT_TIMEOUT_MS = 4000;
var DEFAULT_RETRIES = 2;
var DEFAULT_BASE_DELAY_MS = 1000;
var MAX_RETRY_DELAY_MS = 30000;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function isTransientStatus(response) {
  if (response.status >= 500 || response.status === 429)
    return true;
  if (response.status !== 403)
    return false;
  const retryAfter = response.headers.get("retry-after");
  const remaining = response.headers.get("x-ratelimit-remaining");
  return Boolean(retryAfter) || remaining === "0";
}
function parseRetryAfterMs(response) {
  const header = response.headers.get("retry-after");
  if (!header)
    return 0;
  const seconds = parseInt(header, 10);
  if (isNaN(seconds) || seconds <= 0)
    return 0;
  return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
}
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
async function fetchWithRetry(url, options, retryOptions = {}) {
  const timeoutMs = retryOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = retryOptions.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = retryOptions.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  let lastError;
  for (let attempt = 0;attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      if (isTransientStatus(response) && attempt < retries) {
        const retryAfterMs = parseRetryAfterMs(response);
        await sleep(Math.max(retryAfterMs, baseDelayMs * (attempt + 1)));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(baseDelayMs * (attempt + 1));
        continue;
      }
    }
  }
  throw lastError ?? new Error("fetch failed after retries");
}

// github/script/context.ts
function getContext() {
  const owner = process.env.GITHUB_REPOSITORY_OWNER;
  const repo = process.env.GITHUB_REPOSITORY_NAME;
  const runId = process.env.GITHUB_RUN_ID;
  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const repository = process.env.GITHUB_REPOSITORY;
  if (!owner || !repo || !runId || !repository) {
    throw new Error("Missing required GitHub environment variables");
  }
  const issueNumber = process.env.ISSUE_NUMBER || process.env.PR_NUMBER;
  const commentId = process.env.COMMENT_ID;
  const createdAt = process.env.COMMENT_CREATED_AT || process.env.ISSUE_CREATED_AT;
  return {
    repo: { owner, repo },
    issue: issueNumber ? { number: parseInt(issueNumber, 10) } : null,
    comment: commentId ? {
      id: parseInt(commentId, 10),
      createdAt: createdAt || new Date().toISOString()
    } : null,
    createdAt: createdAt || new Date().toISOString(),
    eventName: process.env.EVENT_NAME || process.env.GITHUB_EVENT_NAME || "",
    runId: parseInt(runId, 10),
    runUrl: `${serverUrl}/${repository}/actions/runs/${runId}`,
    serverUrl,
    actor: process.env.GITHUB_ACTOR || "",
    ref: process.env.GITHUB_REF || "",
    defaultBranch: process.env.DEFAULT_BRANCH || "main"
  };
}
var core = {
  info: (message) => {
    console.log(message);
  },
  warning: (message) => {
    console.log(`::warning::${message}`);
  },
  error: (message) => {
    console.log(`::error::${message}`);
  },
  setFailed: (message) => {
    console.log(`::error::${message}`);
    process.exit(1);
  },
  setOutput: (name, value) => {
    const outputFile = process.env.GITHUB_OUTPUT;
    if (outputFile) {
      const fs = __require("fs");
      if (value.includes(`
`)) {
        const delimiter = `BONK_${crypto.randomUUID().replace(/-/g, "")}`;
        fs.appendFileSync(outputFile, `${name}<<${delimiter}
${value}
${delimiter}
`);
      } else {
        fs.appendFileSync(outputFile, `${name}=${value}
`);
      }
    }
  }
};
async function getOidcToken(audience = "opencode-github-action") {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error("OIDC token request credentials not available");
  }
  const response = await fetchWithRetry(`${requestUrl}&audience=${audience}`, {
    headers: { Authorization: `bearer ${requestToken}` }
  });
  if (!response.ok) {
    throw new Error(`Failed to get OIDC token: ${response.status}`);
  }
  const data = await response.json();
  if (!data.value) {
    throw new Error("OIDC token response missing value");
  }
  return data.value;
}
function getApiBaseUrl() {
  const oidcBaseUrl = process.env.OIDC_BASE_URL;
  if (!oidcBaseUrl) {
    throw new Error("OIDC_BASE_URL not set");
  }
  const normalized = oidcBaseUrl.replace(/\/+$/, "");
  return normalized.replace(/\/auth$/, "");
}
async function detectForkFromPR(headRepo, baseRepo, prUrl, ghToken) {
  if (baseRepo && !headRepo) {
    return { isFork: true };
  }
  if (headRepo && baseRepo) {
    return { isFork: headRepo !== baseRepo };
  }
  if (!prUrl || !ghToken)
    return null;
  try {
    const resp = await fetchWithRetry(prUrl, {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/vnd.github+json"
      }
    });
    if (!resp.ok)
      return null;
    const pr = await resp.json();
    const head = pr.head?.repo?.full_name;
    const base = pr.base?.repo?.full_name;
    return { isFork: !head || head !== base, headSha: pr.head?.sha };
  } catch {
    return null;
  }
}

// github/script/orchestrate.ts
import { readFileSync } from "fs";
import { join } from "path";
var OPENCODE_REPO = "anomalyco/opencode";
var FORK_COMMENT_MARKER = "<!-- bonk-fork-unsupported -->";
var CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
async function githubApi(path, token) {
  const resp = await fetchWithRetry(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json"
    }
  });
  if (!resp.ok) {
    if (resp.status === 404)
      return null;
    throw new Error(`GitHub API ${path} returned ${resp.status}: ${await resp.text()}`);
  }
  return await resp.json();
}
function parseCodeowners(content) {
  const owners = new Set;
  const teamPatterns = [];
  for (const line of content.split(`
`)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#"))
      continue;
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
async function checkCodeowners(owner, repo, ref, actor, token) {
  let codeownersContent = "";
  for (const path of CODEOWNERS_PATHS) {
    const data = await githubApi(`/repos/${owner}/${repo}/contents/${path}?ref=${ref || "HEAD"}`, token);
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
      const membership = await githubApi(`/orgs/${org}/teams/${team}/memberships/${actor}`, token);
      if (membership) {
        core.info(`User ${actor} is a member of team @${teamPath}`);
        return;
      }
    } catch (e) {
      const error = e;
      core.warning(`Could not check team membership for @${teamPath}: ${error.message}`);
    }
  }
  core.setFailed(`User ${actor} is not listed in CODEOWNERS`);
}
async function checkPermissions() {
  const requiredPermission = process.env.REQUIRED_PERMISSION;
  if (!requiredPermission) {
    return core.setFailed("REQUIRED_PERMISSION not set");
  }
  if (requiredPermission === "any")
    return;
  const token = process.env.GH_TOKEN;
  if (!token) {
    return core.setFailed("GH_TOKEN not set");
  }
  const repository = process.env.GITHUB_REPOSITORY || "";
  const [owner = "", repo = ""] = repository.split("/");
  const actor = process.env.COMMENT_ACTOR || process.env.REVIEW_ACTOR || process.env.GITHUB_ACTOR || "";
  const ref = process.env.GITHUB_REF || "HEAD";
  if (!owner || !repo || !actor) {
    return core.setFailed("Missing required context (owner, repo, or actor)");
  }
  if (requiredPermission === "CODEOWNERS") {
    await checkCodeowners(owner, repo, ref, actor, token);
    return;
  }
  const data = await githubApi(`/repos/${owner}/${repo}/collaborators/${actor}/permission`, token);
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
    core.setFailed(`Unknown permission level: ${requiredPermission}. Use 'admin', 'write', 'any', or 'CODEOWNERS'`);
  }
}
async function checkSetup() {
  const context = getContext();
  const { owner, repo } = context.repo;
  const issueNumber = context.issue?.number;
  const defaultBranch = context.defaultBranch;
  const eventName = process.env.EVENT_NAME || "";
  if (!issueNumber) {
    if (eventName === "pull_request" || eventName === "pull_request_review" || eventName === "pull_request_review_comment" || eventName === "issue_comment" || eventName === "issues") {
      core.setFailed("No issue number found for PR/issue event; cannot run setup check");
      return true;
    }
    core.info("No issue number found, skipping setup check");
    return false;
  }
  let oidcToken;
  try {
    oidcToken = await getOidcToken();
  } catch (error) {
    const oidcAvailable = !!process.env.ACTIONS_ID_TOKEN_REQUEST_URL && !!process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (oidcAvailable) {
      core.setFailed(`OIDC token exchange failed unexpectedly: ${error}`);
      return true;
    }
    core.warning("OIDC not available, skipping setup check");
    return false;
  }
  const apiBase = getApiBaseUrl();
  let response;
  try {
    response = await fetchWithRetry(`${apiBase}/api/github/setup`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        owner,
        repo,
        issue_number: issueNumber,
        default_branch: defaultBranch
      })
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
  const data = await response.json();
  if (data.error) {
    core.setFailed(`Setup failed: ${data.error}`);
    return true;
  }
  if (data.exists) {
    core.info("Workflow file exists");
    return false;
  } else {
    core.info(`Workflow file missing - PR created: ${data.prUrl}`);
    core.setOutput("skip", "true");
    return true;
  }
}
async function resolveVersion() {
  const isDev = process.env.OPENCODE_DEV === "true";
  const ghToken = process.env.GH_TOKEN || "";
  const headers = {
    Accept: "application/vnd.github+json"
  };
  if (ghToken) {
    headers.Authorization = `Bearer ${ghToken}`;
  }
  if (isDev) {
    let version2 = "dev";
    try {
      const resp = await fetchWithRetry(`https://api.github.com/repos/${OPENCODE_REPO}/commits/dev`, { headers });
      if (resp.ok) {
        const data = await resp.json();
        if (data.sha) {
          version2 = data.sha.slice(0, 7);
        }
      }
    } catch {}
    return { version: `dev-${version2}`, dev: true, cacheable: true };
  }
  const embeddedVersion = process.env.OPENCODE_EMBEDDED_VERSION;
  if (embeddedVersion && embeddedVersion !== "latest") {
    core.info(`Using embedded version: ${embeddedVersion}`);
    return { version: embeddedVersion, dev: false, cacheable: true };
  }
  let version = "latest";
  try {
    const resp = await fetchWithRetry(`https://api.github.com/repos/${OPENCODE_REPO}/releases/latest`, { headers });
    if (resp.ok) {
      const data = await resp.json();
      if (data.tag_name) {
        version = data.tag_name;
      }
    }
  } catch {}
  return {
    version,
    dev: false,
    cacheable: version !== "latest"
  };
}
async function detectFork() {
  const eventName = process.env.EVENT_NAME;
  const ghToken = process.env.GH_TOKEN;
  switch (eventName) {
    case "pull_request":
    case "pull_request_review_comment":
    case "pull_request_review": {
      const result = await detectForkFromPR(process.env.PR_HEAD_REPO, process.env.PR_BASE_REPO, process.env.PR_URL, ghToken);
      if (!result) {
        core.warning("Fork detection failed for PR event");
        return { isFork: false, detectionFailed: true };
      }
      return result;
    }
    case "issue_comment": {
      const prNumber = process.env.PR_NUMBER;
      const repository = process.env.REPOSITORY;
      if (!prNumber || !repository)
        return { isFork: false };
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
function resolvePRNumber() {
  return process.env.ISSUE_NUMBER || process.env.PR_NUMBER || "";
}
async function resolveHeadSha(prNumber, repository, cachedSha) {
  const envSha = process.env.HEAD_SHA;
  if (envSha)
    return envSha;
  if (cachedSha)
    return cachedSha;
  const ghToken = process.env.GH_TOKEN;
  if (!prNumber || !repository || !ghToken)
    return "";
  try {
    const resp = await fetchWithRetry(`https://api.github.com/repos/${repository}/pulls/${prNumber}`, {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/vnd.github+json"
      }
    });
    if (!resp.ok)
      return "";
    const pr = await resp.json();
    return pr.head?.sha || "";
  } catch {
    return "";
  }
}
function buildForkGuidance(prNumber, owner, repo, headSha) {
  const actionPath = process.env.ACTION_PATH;
  if (!actionPath) {
    core.warning("ACTION_PATH not set, using minimal fork guidance");
    return `This PR is from a fork. You are in comment-only mode for PR #${prNumber} in ${owner}/${repo}. Do not attempt git write operations.`;
  }
  let guidance;
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
async function buildPrompt() {
  const detection = await detectFork();
  if (detection.detectionFailed) {
    core.setFailed("Fork status could not be verified; refusing to proceed.");
    return { isFork: false, prompt: "" };
  }
  const parts = [];
  if (detection.isFork) {
    const prNumber = resolvePRNumber();
    const repository = process.env.REPOSITORY || "";
    const [owner = "", repo = ""] = repository.split("/");
    const headSha = await resolveHeadSha(prNumber, repository, detection.headSha);
    if (!prNumber || !owner || !repo) {
      core.warning("Cannot determine PR context for fork guidance; using minimal guidance");
      parts.push("This PR is from a fork. You are in comment-only mode. Do not attempt git write operations.");
    } else {
      parts.push(buildForkGuidance(prNumber, owner, repo, headSha));
    }
    core.info("PR is from a fork. Fork guidance prompt built.");
  }
  const userPrompt = process.env.USER_PROMPT;
  if (userPrompt) {
    parts.push(userPrompt);
  }
  return { isFork: detection.isFork, prompt: parts.join(`

`) };
}
function maskValue(value) {
  if (value) {
    console.log(`::add-mask::${value}`);
  }
}
function appendToGithubEnv(name, value) {
  const envFile = process.env.GITHUB_ENV;
  if (!envFile) {
    core.warning("GITHUB_ENV not set; cannot export environment variable");
    return;
  }
  const fs = __require("fs");
  if (value.includes(`
`)) {
    const delimiter = `BONK_${crypto.randomUUID().replace(/-/g, "")}`;
    fs.appendFileSync(envFile, `${name}<<${delimiter}
${value}
${delimiter}
`);
  } else {
    fs.appendFileSync(envFile, `${name}=${value}
`);
  }
}
async function exchangeOidc() {
  const fallbackToken = process.env.FALLBACK_TOKEN || "";
  function failWithFallback(reason) {
    core.warning(`OIDC exchange failed: ${reason}`);
    maskValue(fallbackToken);
    appendToGithubEnv("GH_TOKEN", fallbackToken);
    return { failed: true, token: fallbackToken };
  }
  const oidcUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const oidcRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!oidcUrl || !oidcRequestToken) {
    return failWithFallback("OIDC credentials not available (expected for fork PRs)");
  }
  let actionOidcToken;
  try {
    actionOidcToken = await getOidcToken();
  } catch (error) {
    return failWithFallback(`Failed to get OIDC token: ${error}`);
  }
  const rawOidcBaseUrl = process.env.OIDC_BASE_URL;
  if (!rawOidcBaseUrl) {
    return failWithFallback("OIDC_BASE_URL not set");
  }
  const oidcBaseUrl = rawOidcBaseUrl.replace(/\/+$/, "");
  let appToken;
  try {
    const resp = await fetchWithRetry(`${oidcBaseUrl}/exchange_github_app_token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${actionOidcToken}`,
        "Content-Type": "application/json"
      }
    }, { timeoutMs: 1e4 });
    if (!resp.ok) {
      const text = await resp.text();
      let errorMessage = "Unknown error";
      try {
        const data2 = JSON.parse(text);
        errorMessage = data2.error || errorMessage;
      } catch {
        errorMessage = text || errorMessage;
      }
      return failWithFallback(`Token exchange returned ${resp.status}: ${errorMessage}`);
    }
    const data = await resp.json();
    if (!data.token) {
      return failWithFallback("Token exchange response missing token");
    }
    appToken = data.token;
  } catch (error) {
    return failWithFallback(`Token exchange request failed: ${error}`);
  }
  maskValue(appToken);
  appendToGithubEnv("GH_TOKEN", appToken);
  return { failed: false, token: appToken };
}
async function handleFork(oidcFailed) {
  const forksEnabled = process.env.FORKS !== "false";
  if (!forksEnabled) {
    core.info("Fork PR detected but forks input is disabled. Skipping silently.");
    return false;
  }
  if (!oidcFailed) {
    core.info("Fork PR with OIDC token available. OpenCode will run in comment-only mode.");
    return true;
  }
  const repository = process.env.REPOSITORY;
  const issueNumber = process.env.ISSUE_NUMBER;
  const actor = process.env.ACTOR;
  const ghToken = process.env.GH_TOKEN;
  if (!repository || !issueNumber || !ghToken) {
    core.warning("OIDC unavailable for fork PR and missing context to post comment. " + "This is expected when GitHub restricts id-token permissions for fork workflow runs.");
    return false;
  }
  try {
    const resp = await fetchWithRetry(`https://api.github.com/repos/${repository}/issues/${issueNumber}/comments?per_page=100&direction=desc`, {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/vnd.github+json"
      }
    });
    if (resp.ok) {
      const comments = await resp.json();
      if (comments.some((c) => c.body?.includes(FORK_COMMENT_MARKER))) {
        core.info("Fork unsupported comment already posted.");
        return false;
      }
    }
  } catch {}
  const mention = actor ? `@${actor} ` : "";
  const body = `${FORK_COMMENT_MARKER}
` + `${mention}bonk can't run on pull requests from forks due to ` + `[GitHub Actions permission restrictions](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect).`;
  try {
    const resp = await fetchWithRetry(`https://api.github.com/repos/${repository}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/vnd.github+json"
      },
      body: JSON.stringify({ body })
    });
    if (resp.ok) {
      core.info("Posted fork unsupported comment.");
    } else {
      core.warning(`Failed to post fork comment (${resp.status}). Token may be read-only.`);
    }
  } catch (error) {
    core.warning(`Failed to post fork comment: ${error}`);
  }
  return false;
}
async function trackRun() {
  const context = getContext();
  const { owner, repo } = context.repo;
  if (!context.issue?.number) {
    core.info("No issue number found, skipping tracking");
    return;
  }
  let oidcToken;
  try {
    oidcToken = await getOidcToken();
  } catch (error) {
    core.warning(`Failed to get OIDC token: ${error}`);
    return;
  }
  const apiBase = getApiBaseUrl();
  const payload = {
    owner,
    repo,
    run_id: context.runId,
    run_url: context.runUrl,
    issue_number: context.issue.number,
    created_at: context.createdAt
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
  let response;
  try {
    response = await fetchWithRetry(`${apiBase}/api/github/track`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
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
  const data = await response.json();
  if (data.error) {
    core.warning(`Track failed: ${data.error}`);
    return;
  }
  core.info(`Successfully started tracking run ${context.runId}`);
}
async function main() {
  const requiredPermission = process.env.REQUIRED_PERMISSION;
  if (requiredPermission && requiredPermission !== "any") {
    await checkPermissions();
  }
  const shouldSkip = await checkSetup();
  if (shouldSkip) {
    return;
  }
  const [versionResult, promptResult, oidcResult] = await Promise.all([
    resolveVersion().catch((error) => {
      core.warning(`Failed to get opencode version: ${error}`);
      const isDev = process.env.OPENCODE_DEV === "true";
      return {
        version: isDev ? "dev-dev" : "latest",
        dev: isDev,
        cacheable: false
      };
    }),
    buildPrompt(),
    exchangeOidc()
  ]);
  core.setOutput("version", versionResult.version);
  core.setOutput("dev", String(versionResult.dev));
  core.setOutput("cacheable", String(versionResult.cacheable));
  core.setOutput("is_fork", String(promptResult.isFork));
  core.setOutput("value", promptResult.prompt);
  core.setOutput("oidc_failed", String(oidcResult.failed));
  if (promptResult.isFork) {
    const runOpencode = await handleFork(oidcResult.failed);
    core.setOutput("run_opencode", String(runOpencode));
    return;
  }
  if (oidcResult.failed) {
    core.setFailed("OIDC token exchange failed. Ensure id-token: write is configured.");
    return;
  }
  await trackRun();
}
main().catch((error) => {
  core.setFailed(`Orchestration failed: ${error}`);
});
