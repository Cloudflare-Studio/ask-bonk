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

// Detect whether the current event is from a fork PR.
// For pull_request_review_comment and pull_request_review events, head/base repo
// are available directly in the event payload via env vars.
// For issue_comment events on PRs, we fetch PR data via the GitHub API since the
// issue_comment payload doesn't include full PR repo info.
async function detectFork(): Promise<boolean> {
  const eventName = process.env.EVENT_NAME;
  const headRepo = process.env.PR_HEAD_REPO;
  const baseRepo = process.env.PR_BASE_REPO;
  const repository = process.env.REPOSITORY;
  const prNumber = process.env.PR_NUMBER;
  const ghToken = process.env.GH_TOKEN;

  switch (eventName) {
    case "pull_request_review_comment":
    case "pull_request_review":
      if (headRepo && baseRepo) {
        return headRepo !== baseRepo;
      }
      return false;

    case "issue_comment":
      // Only check if this is a comment on a PR (PR_NUMBER is set)
      if (!prNumber || !repository || !ghToken) return false;
      try {
        const resp = await fetch(`https://api.github.com/repos/${repository}/pulls/${prNumber}`, {
          headers: {
            Authorization: `Bearer ${ghToken}`,
            Accept: "application/vnd.github+json",
          },
        });
        if (!resp.ok) return false;
        const pr = (await resp.json()) as {
          head?: { repo?: { full_name?: string } };
          base?: { repo?: { full_name?: string } };
        };
        const head = pr.head?.repo?.full_name;
        const base = pr.base?.repo?.full_name;
        return !!head && !!base && head !== base;
      } catch {
        return false;
      }

    default:
      return false;
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
    core.warning("Cannot post fork skip comment: missing REPOSITORY, GH_TOKEN, or issue number");
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
    core.warning(`Failed to post fork skip comment: ${resp.status} ${resp.statusText}`);
  }
}

async function main() {
  const isFork = await detectFork();
  core.setOutput("is_fork", String(isFork));

  if (isFork) {
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

  if (isFork) {
    const actionPath = process.env.ACTION_PATH;
    if (!actionPath) {
      core.setFailed("ACTION_PATH not set");
      return;
    }
    const guidance = readFileSync(join(actionPath, "fork_guidance.md"), "utf-8");
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
