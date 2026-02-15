// Detect fork PRs and build the final prompt for OpenCode.
//
// Sets is_fork output so action.yml can route accordingly.
// For forks: builds a fork guidance prompt optimistically (the fork handler
// step in action.yml decides whether OpenCode actually runs based on OIDC).
// For non-forks: passes through the user prompt.

import { core, detectForkFromPR } from "./context";
import { readFileSync } from "fs";
import { join } from "path";
import { fetchWithRetry } from "./http";

interface ForkDetectionResult {
  isFork: boolean;
  headSha?: string;
  detectionFailed?: boolean;
}

// Detect whether the current event is from a fork PR.
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

// Resolve the PR number from available env vars.
function resolvePRNumber(): string {
  return process.env.ISSUE_NUMBER || process.env.PR_NUMBER || "";
}

// Resolve the HEAD SHA for the PR.
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

// Build fork guidance prompt from template.
function buildForkGuidance(
  prNumber: string,
  owner: string,
  repo: string,
  headSha: string,
): string {
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

async function main() {
  const detection = await detectFork();
  core.setOutput("is_fork", String(detection.isFork));

  if (detection.detectionFailed) {
    core.setFailed("Fork status could not be verified; refusing to proceed.");
    return;
  }

  const parts: string[] = [];

  if (detection.isFork) {
    // Build fork guidance prompt. The fork handler step in action.yml decides
    // whether OpenCode actually runs (OIDC must succeed). We build the prompt
    // optimistically so it's ready if needed.
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

  core.setOutput("value", parts.join("\n\n"));
}

main().catch((error) => {
  core.setFailed(`Unexpected error: ${error}`);
});
