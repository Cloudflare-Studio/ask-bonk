// Trusted finalization stage. Pi emits data and worktree changes; this stage
// owns every GitHub mutation and the Git commit/push lifecycle.

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  getApiBaseUrl,
  getContext,
  getOidcToken,
  exchangeGitHubAppToken,
  parseCodeownersTeamGroups,
  core,
} from "./context";
import { fetchWithRetry } from "./http";
import { parseBonkResult, type BonkFinding, type BonkResult } from "../extensions/bonk-result";
import { gitControlStateDigest } from "./prepare-worktree";

const API_VERSION = "2022-11-28";
const MAX_COMMENT_LENGTH = 65_000;

interface PullRequestData {
  html_url: string;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string };
}

interface IssueComment {
  id: number;
  body?: string;
}

interface ReviewComment {
  body?: string;
}

function git(args: string[]): string {
  return execFileSync(
    "/usr/bin/git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "credential.helper=",
      ...args,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Git hooks and filters must not inherit Finalize credentials even if
      // Pi changed repository-local Git configuration.
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        TMPDIR: process.env.TMPDIR,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  ).trim();
}

function repositoryRemote(): string {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must use owner/repo format");
  }
  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  return `${new URL(serverUrl).origin}/${repository}.git`;
}

function gitWithToken(args: string[]): string {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("Missing GitHub installation token during finalization");
  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const basicAuth = Buffer.from(`x-access-token:${token}`).toString("base64");
  try {
    return git([
      "-c",
      `http.${serverUrl}/.extraheader=AUTHORIZATION: basic ${basicAuth}`,
      ...args,
    ]);
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr || "")
        : "";
    throw new Error(`Git ${args[0] || "command"} failed${stderr ? `: ${stderr.trim()}` : ""}`);
  }
}

function worktreeStatus(): string {
  return git(["status", "--porcelain=v1", "--untracked-files=all"]);
}

function assertPreparedGitState(): void {
  const initialSha = process.env.INITIAL_SHA;
  const localBranch = process.env.LOCAL_BRANCH;
  const initialGitStateDigest = process.env.INITIAL_GIT_STATE_DIGEST;
  if (!initialSha || !localBranch || !initialGitStateDigest) {
    throw new Error("Missing prepared Git state");
  }
  if (gitControlStateDigest() !== initialGitStateDigest) {
    throw new Error("Pi changed repository-local Git control state during the Run phase");
  }
  if (git(["rev-parse", "HEAD"]) !== initialSha) {
    throw new Error("Pi changed Git history during the Run phase");
  }
  if (git(["branch", "--show-current"]) !== localBranch) {
    throw new Error("Pi changed the prepared branch during the Run phase");
  }
}

async function githubApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("Missing GitHub installation token during finalization");
  const method = (init.method || "GET").toUpperCase();
  const response = await fetchWithRetry(
    `https://api.github.com${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": API_VERSION,
        ...init.headers,
      },
    },
    // Retrying a POST after an ambiguous network failure can duplicate a
    // comment, review, or pull request. A workflow rerun is safe because each
    // mutation has a run marker or deterministic branch lookup.
    { retries: method === "POST" ? 0 : 2 },
  );
  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed (${response.status}): ${await response.text()}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function readResult(): BonkResult {
  const resultPath = process.env.BONK_RESULT_PATH;
  if (!resultPath || !existsSync(resultPath)) {
    throw new Error("Pi succeeded without a structured Bonk result");
  }
  return parseBonkResult(JSON.parse(readFileSync(resultPath, "utf8")));
}

function markedCommentBody(body: string, marker: string): string {
  const suffix = `\n\n${marker}`;
  const truncation = "\n\n[Response truncated by Bonk]";
  const available = MAX_COMMENT_LENGTH - suffix.length;
  const visible =
    body.length > available
      ? `${body.slice(0, Math.max(0, available - truncation.length))}${truncation}`
      : body;
  return `${visible}${suffix}`;
}

export function assertResultMatchesWorktree(result: BonkResult, mode: string, status: string): void {
  if (mode === "review-only" && status) {
    throw new Error("Pi modified the worktree during a review-only run");
  }
  if (result.kind === "change" && !status) {
    throw new Error("Pi submitted a change result without worktree changes");
  }
  if (result.kind !== "change" && status) {
    throw new Error(`Pi submitted a ${result.kind} result with unexpected worktree changes`);
  }
}

function commentMarker(): string {
  return `<!-- bonk-run:${process.env.GITHUB_RUN_ID || "unknown"} -->`;
}

function reviewMarker(): string {
  return `<!-- bonk-review:${process.env.GITHUB_RUN_ID || "unknown"} -->`;
}

export async function publishTopLevelResponse(body: string): Promise<void> {
  const issueNumber = process.env.ISSUE_NUMBER;
  if (!issueNumber) {
    const stepSummary = process.env.GITHUB_STEP_SUMMARY;
    if (stepSummary) appendFileSync(stepSummary, `## Bonk\n\n${body}\n`);
    core.info(body);
    return;
  }

  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("Missing GITHUB_REPOSITORY");
  const marker = commentMarker();
  const markedBody = markedCommentBody(body, marker);
  const comments = await githubApi<IssueComment[]>(
    `/repos/${repository}/issues/${issueNumber}/comments?per_page=100&direction=desc`,
  );
  const existing = comments.find((comment) => comment.body?.includes(marker));
  if (existing) {
    await githubApi(`/repos/${repository}/issues/comments/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify({ body: markedBody }),
    });
    return;
  }
  await githubApi(`/repos/${repository}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: markedBody }),
  });
}

function toReviewComment(finding: BonkFinding, marker: string): Record<string, unknown> {
  const endLine = finding.endLine ?? finding.line;
  return {
    path: finding.path,
    line: endLine,
    side: "RIGHT",
    ...(finding.endLine === undefined
      ? {}
      : { start_line: finding.line, start_side: "RIGHT" }),
    body: `${finding.body}\n\n${marker}`,
  };
}

export async function publishReview(
  result: Extract<BonkResult, { kind: "review" }>,
): Promise<string> {
  const repository = process.env.GITHUB_REPOSITORY;
  const prNumber = process.env.PR_NUMBER || process.env.ISSUE_NUMBER;
  if (!repository || !prNumber) {
    throw new Error("Review results require repository and pull request context");
  }
  if (result.findings.length === 0) return result.body;

  const marker = reviewMarker();
  const existingComments = await githubApi<ReviewComment[]>(
    `/repos/${repository}/pulls/${prNumber}/comments?per_page=100&sort=created&direction=desc`,
  );
  if (!existingComments.some((comment) => comment.body?.includes(marker))) {
    const commitId = process.env.HEAD_SHA || git(["rev-parse", "HEAD"]);
    await githubApi(`/repos/${repository}/pulls/${prNumber}/reviews`, {
      method: "POST",
      body: JSON.stringify({
        commit_id: commitId,
        event: "COMMENT",
        body: "",
        comments: result.findings.map((finding) => toReviewComment(finding, marker)),
      }),
    });
  }
  return result.body || `Posted ${result.findings.length} inline review comments.`;
}

function commitTitle(result: Extract<BonkResult, { kind: "change" }>): string {
  return result.commitTitle || "Apply Bonk changes";
}

export function assertPullRequestPushAllowed(
  pullRequest: PullRequestData,
  repository: string,
  initialSha?: string,
): void {
  if (pullRequest.head.repo?.full_name !== repository) {
    throw new Error("Bonk will not push changes to a fork pull request");
  }
  if (initialSha && pullRequest.head.sha !== initialSha) {
    throw new Error("Pull request head changed after the Prepare phase; refusing to push");
  }
}

async function createOrFindPullRequest(
  result: Extract<BonkResult, { kind: "change" }>,
  branch: string,
): Promise<string> {
  const repository = process.env.GITHUB_REPOSITORY;
  const defaultBranch = process.env.DEFAULT_BRANCH || "main";
  if (!repository) throw new Error("Missing GITHUB_REPOSITORY");
  const [owner] = repository.split("/");
  const existing = await githubApi<Array<{ html_url: string }>>(
    `/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
  );
  if (existing[0]?.html_url) return existing[0].html_url;

  const created = await githubApi<{ html_url: string }>(`/repos/${repository}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: result.pullRequestTitle || commitTitle(result),
      body: result.pullRequestBody || result.body,
      head: branch,
      base: defaultBranch,
    }),
  });
  return created.html_url;
}

async function finalizeChange(
  result: Extract<BonkResult, { kind: "change" }>,
): Promise<string> {
  const repository = process.env.GITHUB_REPOSITORY;
  const localBranch = process.env.LOCAL_BRANCH;
  if (!repository || !localBranch) throw new Error("Missing prepared worktree context");

  git(["config", "user.name", "ask-bonk[bot]"]);
  git(["config", "user.email", "ask-bonk[bot]@users.noreply.github.com"]);
  git(["add", "-A"]);
  if (!git(["diff", "--cached", "--name-only"])) {
    throw new Error("Pi submitted a change result without stageable changes");
  }
  git(["commit", "-m", commitTitle(result)]);
  const pushUrl = repositoryRemote();

  const prNumber = process.env.PR_NUMBER;
  if (prNumber) {
    const pullRequest = await githubApi<PullRequestData>(
      `/repos/${repository}/pulls/${prNumber}`,
    );
    assertPullRequestPushAllowed(pullRequest, repository, process.env.INITIAL_SHA);
    gitWithToken(["push", pushUrl, `HEAD:refs/heads/${pullRequest.head.ref}`]);
    return result.body;
  }

  gitWithToken(["push", pushUrl, `HEAD:refs/heads/${localBranch}`]);
  const prUrl = await createOrFindPullRequest(result, localBranch);
  return `${result.body}\n\n${prUrl}`;
}

function validateResult(result: BonkResult): void {
  assertPreparedGitState();
  const status = worktreeStatus();
  assertResultMatchesWorktree(result, process.env.RUN_MODE || "review-only", status);
}

async function publishResult(result: BonkResult): Promise<void> {
  // Recheck after token exchange as well. Pi has exited, but this keeps the
  // credentialed publication path independently guarded.
  validateResult(result);
  let body: string;
  if (result.kind === "review") {
    body = await publishReview(result);
  } else if (result.kind === "change") {
    body = await finalizeChange(result);
  } else {
    body = result.body;
  }
  await publishTopLevelResponse(body);
}

async function finalizeTracking(status: string): Promise<void> {
  try {
    const context = getContext();
    const { owner, repo } = context.repo;
    let oidcToken: string;
    try {
      oidcToken = await getOidcToken();
    } catch (error) {
      core.warning(`Failed to get OIDC token for finalize: ${error}`);
      return;
    }

    const response = await fetchWithRetry(`${getApiBaseUrl()}/api/github/track`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        owner,
        repo,
        run_id: context.runId,
        status,
        issue_number: context.issue?.number,
        run_url: context.runUrl,
      }),
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

export async function finalizeRun(): Promise<void> {
  const piStatus = normalizePiStatus(process.env.PI_STATUS);
  let publishError: unknown;

  if (piStatus === "success") {
    const previousToken = process.env.GH_TOKEN;
    try {
      const result = readResult();
      validateResult(result);
      process.env.GH_TOKEN = await exchangeGitHubAppToken({
        forceNoPush: process.env.IS_FORK === "true",
        tokenPermissions: process.env.TOKEN_PERMISSIONS,
        codeownersTeamGroups: parseCodeownersTeamGroups(
          process.env.CODEOWNERS_TEAM_GROUPS,
        ),
        actor: process.env.ACTOR || process.env.GITHUB_ACTOR,
      });
      await publishResult(result);
    } catch (error) {
      publishError = error;
    } finally {
      if (previousToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousToken;
    }
  }

  await finalizeTracking(publishError ? "failure" : piStatus);
  if (publishError) throw publishError;
}

export function normalizePiStatus(status: string | undefined): string {
  const resolved = status || "unknown";
  return resolved === "skipped" ? "failure" : resolved;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  finalizeRun().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if ((process.env.PI_STATUS || "unknown") === "success") {
      console.error(`Bonk finalization failed: ${message}`);
      process.exitCode = 1;
    } else {
      core.warning(`Unexpected error in finalize: ${message}`);
    }
  });
}
