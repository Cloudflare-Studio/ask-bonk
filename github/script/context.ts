// Context helper for GitHub Action scripts
// Provides a similar interface to actions/github-script's context object

import { fetchWithRetry } from "./http";

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

// Build context from environment variables
export function getContext(): Context {
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
    comment: commentId
      ? {
          id: parseInt(commentId, 10),
          createdAt: createdAt || new Date().toISOString(),
        }
      : null,
    createdAt: createdAt || new Date().toISOString(),
    eventName: process.env.EVENT_NAME || process.env.GITHUB_EVENT_NAME || "",
    runId: parseInt(runId, 10),
    runUrl: `${serverUrl}/${repository}/actions/runs/${runId}`,
    serverUrl,
    actor: process.env.GITHUB_ACTOR || "",
    ref: process.env.GITHUB_REF || "",
    defaultBranch: process.env.DEFAULT_BRANCH || "main",
  };
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
      const fs = require("fs");
      if (value.includes("\n")) {
        // Multiline values need a random delimiter to prevent injection
        const delimiter = `BONK_${crypto.randomUUID().replace(/-/g, "")}`;
        fs.appendFileSync(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
      } else {
        fs.appendFileSync(outputFile, `${name}=${value}\n`);
      }
    }
  },
};

// Get OIDC token from GitHub Actions
export async function getOidcToken(audience: string = "opencode-github-action"): Promise<string> {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!requestUrl || !requestToken) {
    throw new Error("OIDC token request credentials not available");
  }

  const response = await fetchWithRetry(`${requestUrl}&audience=${audience}`, {
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
}

// Get API base URL from OIDC base URL
export function getApiBaseUrl(): string {
  const oidcBaseUrl = process.env.OIDC_BASE_URL;
  if (!oidcBaseUrl) {
    throw new Error("OIDC_BASE_URL not set");
  }
  const normalized = oidcBaseUrl.replace(/\/+$/, "");
  return normalized.replace(/\/auth$/, "");
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
    return { isFork: !head || head !== base, headSha: pr.head?.sha };
  } catch {
    return null;
  }
}
