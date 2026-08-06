// Prepares the authoritative local branch, then removes GitHub credentials
// before Pi starts. GitHub mutations remain the finalizer's responsibility.

import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";
import { core, exchangeGitHubAppToken, parseCodeownersTeamGroups } from "./context";

function git(args: string[]): string {
  return execFileSync(
    "/usr/bin/git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      ...args,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
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
  const url = new URL(serverUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("GITHUB_SERVER_URL must use http or https");
  }
  return `${url.origin}/${repository}.git`;
}

function gitWithToken(args: string[]): string {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("Missing GitHub installation token while preparing worktree");
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

export function scrubGitCredentials(): void {
  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const remote = repositoryRemote();
  const headerKeys = new Set([
    `http.${serverUrl}/.extraheader`,
    "http.https://github.com/.extraheader",
  ]);
  try {
    for (const key of git([
      "config",
      "--local",
      "--name-only",
      "--get-regexp",
      "^http\\..*\\.extraheader$",
    ]).split("\n")) {
      if (key) headerKeys.add(key);
    }
  } catch {
    // No repository-local HTTP authorization headers are configured.
  }
  for (const key of headerKeys) {
    try {
      git(["config", "--local", "--unset-all", key]);
    } catch {
      // The credential may already be absent.
    }
  }
  try {
    git(["config", "--local", "--unset-all", "credential.helper"]);
  } catch {
    // actions/checkout normally uses an extraheader, not a helper.
  }
  try {
    git(["config", "--local", "--unset-all", "remote.origin.pushurl"]);
  } catch {
    // A separate push URL is uncommon, but must not survive into Finalize.
  }
  git(["remote", "set-url", "origin", remote]);
}

function assertCleanWorktree(): void {
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) {
    throw new Error("Bonk requires a clean worktree before the Pi phase");
  }
}

export interface PreparedWorktree {
  baseSha: string;
  branch: string;
}

export function prepareWorktree(): PreparedWorktree {
  const runId = process.env.GITHUB_RUN_ID;
  if (!runId || !/^\d+$/.test(runId)) throw new Error("Missing valid GITHUB_RUN_ID");
  const prNumber = process.env.PR_NUMBER?.trim();
  const defaultBranch = process.env.DEFAULT_BRANCH?.trim() || "main";
  if (!/^[A-Za-z0-9._/-]+$/.test(defaultBranch) || defaultBranch.includes("..")) {
    throw new Error("Invalid default branch");
  }

  scrubGitCredentials();
  assertCleanWorktree();

  const branch = prNumber ? `bonk/pr-${prNumber}-${runId}` : `bonk/run-${runId}`;
  try {
    if (prNumber) {
      if (!/^\d+$/.test(prNumber)) throw new Error("Invalid pull request number");
      gitWithToken([
        "fetch",
        "--force",
        "origin",
        `+refs/pull/${prNumber}/head:refs/heads/${branch}`,
      ]);
      git(["checkout", "--force", branch]);

      const expectedHead = process.env.HEAD_SHA?.trim();
      const actualHead = git(["rev-parse", "HEAD"]);
      if (expectedHead && actualHead !== expectedHead) {
        throw new Error(`Prepared PR head ${actualHead} does not match authoritative SHA ${expectedHead}`);
      }
    } else {
      gitWithToken([
        "fetch",
        "--force",
        "origin",
        `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`,
      ]);
      git(["checkout", "--force", "-B", branch, `refs/remotes/origin/${defaultBranch}`]);
    }

    const baseSha = git(["rev-parse", "HEAD"]);
    core.setOutput("base_sha", baseSha);
    core.setOutput("branch", branch);
    core.info(`Prepared ${branch} at ${baseSha}`);
    return { baseSha, branch };
  } finally {
    scrubGitCredentials();
  }
}

async function prepareWorktreeWithFreshToken(): Promise<PreparedWorktree> {
  const previousToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = await exchangeGitHubAppToken({
    forceNoPush: process.env.IS_FORK === "true",
    tokenPermissions: process.env.TOKEN_PERMISSIONS,
    codeownersTeamGroups: parseCodeownersTeamGroups(process.env.CODEOWNERS_TEAM_GROUPS),
    actor: process.env.ACTOR || process.env.GITHUB_ACTOR,
  });
  try {
    return prepareWorktree();
  } finally {
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await prepareWorktreeWithFreshToken();
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}
