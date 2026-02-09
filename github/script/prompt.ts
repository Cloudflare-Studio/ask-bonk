// Detect fork PRs and build the final prompt for OpenCode.
// Combines fork detection + prompt assembly into a single step.
//
// When a fork is detected and forks input is "true" (default): prepends fork guidance
// to the prompt, constraining the agent to comment-only mode.
// When a fork is detected and forks input is "false": posts a comment explaining
// fork PRs aren't supported by this workflow, and sets skip=true to halt the run.

import { core } from "./context";
import { readFileSync } from "fs";
import { join } from "path";

interface ForkDetectionResult {
  isFork: boolean;
  // When we fetch PR data during detection (issue_comment events), cache it so
  // resolveHeadSha() can reuse it instead of making a duplicate API call.
  headSha?: string;
}

// Detect whether the current event is from a fork PR.
// For pull_request, pull_request_review_comment, and pull_request_review events,
// head/base repo are available directly in the event payload via env vars.
// For issue_comment events on PRs, we fetch PR data via the GitHub API since the
// issue_comment payload doesn't include full PR repo info.
async function detectFork(): Promise<ForkDetectionResult> {
  const eventName = process.env.EVENT_NAME;
  const headRepo = process.env.PR_HEAD_REPO;
  const baseRepo = process.env.PR_BASE_REPO;
  const repository = process.env.REPOSITORY;
  const prNumber = process.env.PR_NUMBER;
  const ghToken = process.env.GH_TOKEN;

  switch (eventName) {
    case "pull_request":
    case "pull_request_review_comment":
    case "pull_request_review":
      // A null/missing head repo means the fork was deleted — still a fork PR.
      return { isFork: !headRepo || headRepo !== baseRepo };

    case "issue_comment":
      // Only check if this is a comment on a PR (PR_NUMBER is set)
      if (!prNumber || !repository || !ghToken) return { isFork: false };
      try {
        const resp = await fetch(
          `https://api.github.com/repos/${repository}/pulls/${prNumber}`,
          {
            headers: {
              Authorization: `Bearer ${ghToken}`,
              Accept: "application/vnd.github+json",
            },
          },
        );
        if (!resp.ok) return { isFork: false };
        const pr = (await resp.json()) as {
          head?: { repo?: { full_name?: string }; sha?: string };
          base?: { repo?: { full_name?: string } };
        };
        const head = pr.head?.repo?.full_name;
        const base = pr.base?.repo?.full_name;
        // A null/missing head repo means the fork was deleted — still a fork PR.
        const isFork = !head || head !== base;
        return { isFork, headSha: pr.head?.sha };
      } catch {
        return { isFork: false };
      }

    default:
      return { isFork: false };
  }
}

// Post a comment on the PR explaining that fork PRs are not handled by this workflow.
// Uses the GitHub API directly since we're running inside a GitHub Action.
// Deduplicates using an HTML comment marker to avoid spamming on repeated mentions.
const FORK_SKIP_MARKER = "<!-- bonk-fork-skip -->";

async function commentForkSkipped(): Promise<void> {
  const repository = process.env.REPOSITORY;
  const ghToken = process.env.GH_TOKEN;
  // ISSUE_NUMBER covers both PR events and issue_comment events on PRs
  const issueNumber = process.env.ISSUE_NUMBER || process.env.PR_NUMBER;

  if (!repository || !ghToken || !issueNumber) {
    core.warning(
      "Cannot post fork skip comment: missing REPOSITORY, GH_TOKEN, or issue number",
    );
    return;
  }

  // Check if we already posted this comment to avoid duplicate spam
  try {
    const existingResp = await fetch(
      `https://api.github.com/repos/${repository}/issues/${issueNumber}/comments?per_page=30&direction=desc`,
      {
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (existingResp.ok) {
      const comments = (await existingResp.json()) as Array<{ body?: string }>;
      if (comments.some((c) => c.body?.includes(FORK_SKIP_MARKER))) {
        core.info("Fork skip comment already exists, skipping duplicate.");
        return;
      }
    }
  } catch {
    // If the dedup check fails, proceed to post anyway
  }

  const body =
    `${FORK_SKIP_MARKER}\n` +
    "> [!NOTE]\n" +
    "> This workflow is configured to skip pull requests from forks. " +
    "Fork PRs can be reviewed manually, or the workflow can be updated to " +
    "handle forks in comment-only mode by setting `forks: true` in the action configuration.";

  const resp = await fetch(
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

  if (!resp.ok) {
    core.warning(
      `Failed to post fork skip comment: ${resp.status} ${resp.statusText}`,
    );
  }
}

// Resolve the PR number from available env vars.
// ISSUE_NUMBER is set for both issue_comment and pull_request_review events.
// PR_NUMBER is set for issue_comment events on PRs (from action.yml).
function resolvePRNumber(): string {
  return process.env.ISSUE_NUMBER || process.env.PR_NUMBER || "";
}

// Resolve the HEAD SHA for the PR. Checks, in order:
// 1. The HEAD_SHA env var (set from the event payload for pull_request_review events)
// 2. A cached SHA from detectFork() (avoids a duplicate API call for issue_comment events)
// 3. Fetching the PR via the GitHub API as a last resort
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
    const resp = await fetch(
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

async function main() {
  const detection = await detectFork();
  core.setOutput("is_fork", String(detection.isFork));

  if (detection.isFork) {
    const forksEnabled = process.env.FORKS !== "false";

    if (!forksEnabled) {
      core.info("PR is from a fork and forks input is disabled. Skipping.");
      await commentForkSkipped();
      core.setOutput("skip", "true");
      return;
    }

    core.info("PR is from a fork. Agent will run in comment-only mode.");
  }

  // Build prompt: fork guidance (if fork) + user prompt (if provided)
  const parts: string[] = [];

  if (detection.isFork) {
    const actionPath = process.env.ACTION_PATH;
    if (!actionPath) {
      core.setFailed("ACTION_PATH not set");
      return;
    }

    // Resolve concrete values for the fork guidance template.
    // The LLM must know the exact PR number, owner/repo, and HEAD SHA so it
    // cannot drift to a different PR (the root cause of the fork handling bug).
    const prNumber = resolvePRNumber();
    const repository = process.env.REPOSITORY || "";
    const [owner = "", repo = ""] = repository.split("/");
    const headSha = await resolveHeadSha(
      prNumber,
      repository,
      detection.headSha,
    );

    if (!prNumber || !owner || !repo) {
      core.setFailed(
        "Cannot determine PR number or repository for fork guidance",
      );
      return;
    }

    let guidance = readFileSync(join(actionPath, "fork_guidance.md"), "utf-8");
    guidance = guidance.replace(/\{\{PR_NUMBER\}\}/g, prNumber);
    guidance = guidance.replace(/\{\{OWNER\}\}/g, owner);
    guidance = guidance.replace(/\{\{REPO\}\}/g, repo);
    guidance = guidance.replace(/\{\{HEAD_SHA\}\}/g, headSha || "UNKNOWN");

    parts.push(guidance.trim());
  }

  const userPrompt = process.env.USER_PROMPT;
  if (userPrompt) {
    parts.push(userPrompt);
  }

  core.setOutput("value", parts.join("\n\n"));
}

main().catch((error) => {
  core.setFailed(`Unexpected error: ${error}`);
});
