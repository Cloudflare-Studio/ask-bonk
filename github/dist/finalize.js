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

// github/script/finalize.ts
async function main() {
  const context = getContext();
  const { owner, repo } = context.repo;
  const status = process.env.OPENCODE_STATUS || "unknown";
  let oidcToken;
  try {
    oidcToken = await getOidcToken();
  } catch (error) {
    core.warning(`Failed to get OIDC token for finalize: ${error}`);
    return;
  }
  const apiBase = getApiBaseUrl();
  try {
    const response = await fetchWithRetry(`${apiBase}/api/github/track`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        owner,
        repo,
        run_id: context.runId,
        status
      })
    });
    if (!response.ok) {
      core.warning(`Failed to finalize Bonk run tracking: ${await response.text()}`);
      return;
    }
    core.info(`Successfully finalized run ${context.runId} with status ${status}`);
  } catch (error) {
    core.warning(`Failed to finalize Bonk run tracking: ${error}`);
  }
}
main().catch((error) => {
  core.warning(`Unexpected error in finalize: ${error}`);
});
