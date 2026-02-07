// Detect fork PRs and build the final prompt for OpenCode.
// Combines fork detection + prompt assembly into a single step.
// Replaces the inline bash "Detect fork PR" and "Build prompt" steps.

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

async function main() {
  const isFork = await detectFork();
  core.setOutput("is_fork", String(isFork));

  if (isFork) {
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
