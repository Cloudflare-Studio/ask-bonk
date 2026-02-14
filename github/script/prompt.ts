// Detect fork PRs and build the final prompt for OpenCode.
// Combines fork detection + prompt assembly into a single step.
//
// When a fork is detected and forks input is "true" (default): prepends fork guidance
// to the prompt, constraining the agent to comment-only mode.
// When a fork is detected and forks input is "false": posts a comment explaining
// fork PRs aren't supported by this workflow, and sets skip=true to halt the run.

import { core, detectForkFromPR } from "./context";
import { fetchWithRetry } from "./http";
import { readFileSync } from "fs";
import { join } from "path";

interface ForkDetectionResult {
  isFork: boolean;
  // When we fetch PR data during detection (issue_comment events), cache it so
  // resolveHeadSha() can reuse it instead of making a duplicate API call.
  headSha?: string;
  detectionFailed?: boolean;
}

// Verify that the token used for fork runs is read-only.
async function assertForkTokenSafety(repository: string, ghToken: string): Promise<void> {
  let resp: Response;
  try {
    resp = await fetchWithRetry(
      `https://api.github.com/repos/${repository}`,
      {
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
  } catch (error) {
    core.setFailed(`Fork token safety check failed: ${error}`);
    return;
  }

  if (!resp.ok) {
    core.setFailed(`Fork token safety check failed (${resp.status}); refusing to proceed.`);
    return;
  }
  const data = (await resp.json()) as { permissions?: { push?: boolean; admin?: boolean } };
  if (data.permissions?.push || data.permissions?.admin) {
    core.setFailed(
      "Fork runs require read-only repository permissions. Remove contents: write from the workflow permissions.",
    );
    return;
  }
}

// Detect whether the current event is from a fork PR.
// Uses the shared detectForkFromPR helper for env-var comparison and API fallback.
// For issue_comment events, constructs a PR URL from REPOSITORY + PR_NUMBER.
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

// Post a comment on the PR explaining that fork PRs are not handled by this workflow.
// Uses the GitHub API directly since we're running inside a GitHub Action.
// Deduplicates using an HTML comment marker to avoid spamming on repeated mentions.
const FORK_SKIP_MARKER = "<!-- bonk-fork-skip -->";

async function commentForkSkipped(reason?: string): Promise<void> {
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
    let page = 1;
    while (page <= 3) {
      const existingResp = await fetchWithRetry(
        `https://api.github.com/repos/${repository}/issues/${issueNumber}/comments?per_page=100&direction=desc&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${ghToken}`,
            Accept: "application/vnd.github+json",
          },
        },
      );
      if (!existingResp.ok) {
        break;
      }
      const comments = (await existingResp.json()) as Array<{ body?: string }>;
      if (comments.some((c) => c.body?.includes(FORK_SKIP_MARKER))) {
        core.info("Fork skip comment already exists, skipping duplicate.");
        return;
      }
      if (comments.length < 100) {
        break;
      }
      page += 1;
    }
  } catch {
    // If the dedup check fails, proceed to post anyway
  }

  const reasonLine = reason ? `\n> ${reason}` : "";
  const body =
    `${FORK_SKIP_MARKER}\n` +
    "> [!NOTE]\n" +
    "> This workflow is configured to skip pull requests from forks. " +
    "Fork PRs can be reviewed manually, or the workflow can be updated to " +
    "handle forks in comment-only mode by setting `forks: true` in the action configuration." +
    reasonLine;

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

    if (!resp.ok) {
      core.warning(`Failed to post fork skip comment: ${resp.status} ${resp.statusText}`);
    }
  } catch (error) {
    core.warning(`Failed to post fork skip comment: ${error}`);
  }
}

// Resolve the PR number from available env vars.
// ISSUE_NUMBER is set for both issue_comment and pull_request_review events.
// PR_NUMBER is set for issue_comment events on PRs (from action.yml).
function resolvePRNumber(): string {
  const direct = process.env.ISSUE_NUMBER || process.env.PR_NUMBER;
  if (direct) return direct;

  const prUrl = process.env.PR_URL || "";
  const match = prUrl.match(/\/pulls\/(\d+)$/);
  return match?.[1] || "";
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

async function main() {
  const detection = await detectFork();
  core.setOutput("is_fork", String(detection.isFork));

  const forksEnabled = process.env.FORKS !== "false";
  if (detection.detectionFailed) {
    core.setFailed("Fork status could not be verified; refusing to proceed.");
    return;
  }

  // detectionFailed already caused an early exit above, so this is just isFork.
  const commentOnly = detection.isFork;

  if (detection.isFork && process.env.EVENT_NAME === "pull_request") {
    core.warning("Fork PRs triggered by pull_request events cannot post comments; skipping.");
    core.setOutput("skip", "true");
    return;
  }

  if (detection.isFork && !forksEnabled) {
    core.info("PR is from a fork and forks input is disabled. Skipping.");
    await commentForkSkipped();
    core.setOutput("skip", "true");
    return;
  }

  // Token safety check only runs when we're about to proceed with a fork run
  if (commentOnly) {
    const repository = process.env.REPOSITORY || "";
    const ghToken = process.env.GH_TOKEN || "";
    if (!repository || !ghToken) {
      core.setFailed("Fork token safety check missing REPOSITORY or GH_TOKEN; refusing to proceed.");
      return;
    }
    await assertForkTokenSafety(repository, ghToken);
    core.info("PR is from a fork. Agent will run in comment-only mode.");
  }

  // Build prompt: fork guidance (if fork) + user prompt (if provided)
  const parts: string[] = [];

  if (commentOnly) {
    const actionPath = process.env.ACTION_PATH;
    if (!actionPath) {
      core.warning("ACTION_PATH not set, continuing without fork guidance");
    }

    // Resolve concrete values for the fork guidance template.
    // The LLM must know the exact PR number, owner/repo, and HEAD SHA so it
    // cannot drift to a different PR (the root cause of the fork handling bug).
    const prNumber = resolvePRNumber();
    const repository = process.env.REPOSITORY || "";
    const [owner = "", repo = ""] = repository.split("/");
    const headSha = await resolveHeadSha(prNumber, repository, detection.headSha);

    if (!prNumber || !owner || !repo) {
      core.warning("Cannot determine PR number or repository for fork guidance; using minimal guidance");
      parts.push("This PR is from a fork. You are in comment-only mode. Do not attempt git write operations.");
    } else if (!actionPath) {
      parts.push(
        `This PR is from a fork. You are in comment-only mode for PR #${prNumber} in ${owner}/${repo}. Do not attempt git write operations.`,
      );
    } else {
      let guidance: string;
      try {
        guidance = readFileSync(join(actionPath, "fork_guidance.md"), "utf-8");
      } catch (error) {
        core.warning(`Could not read fork_guidance.md, using minimal guidance: ${error}`);
        guidance =
          "This PR is from a fork. You are in comment-only mode for PR #{{PR_NUMBER}} in {{OWNER}}/{{REPO}}. Do not attempt git write operations.";
      }

      if (!headSha) {
        core.warning("Could not resolve HEAD SHA for fork PR; inline review comments may fail");
      }

      guidance = guidance.replace(/\{\{PR_NUMBER\}\}/g, prNumber);
      guidance = guidance.replace(/\{\{OWNER\}\}/g, owner);
      guidance = guidance.replace(/\{\{REPO\}\}/g, repo);
      guidance = guidance.replace(/\{\{HEAD_SHA\}\}/g, headSha || "UNKNOWN");

      parts.push(guidance.trim());
    }
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
