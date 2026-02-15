// Handle fork PRs: either enable OpenCode in comment-only mode (OIDC succeeded)
// or post a "not supported" comment (OIDC failed).
//
// Outputs:
//   run_opencode=true  — OIDC worked, OpenCode should run with the App token
//   (no output)        — fork was handled here (comment posted or silently skipped)
//
// When forks input is "false", exits silently without posting.

import { core } from "./context";
import { fetchWithRetry } from "./http";

const FORK_COMMENT_MARKER = "<!-- bonk-fork-unsupported -->";

async function main() {
  const forksEnabled = process.env.FORKS !== "false";
  if (!forksEnabled) {
    core.info("Fork PR detected but forks input is disabled. Skipping silently.");
    return;
  }

  const oidcFailed = process.env.OIDC_FAILED === "true";

  // OIDC succeeded — OpenCode can run with the App token in comment-only mode.
  if (!oidcFailed) {
    core.info("Fork PR with OIDC token available. OpenCode will run in comment-only mode.");
    core.setOutput("run_opencode", "true");
    return;
  }

  // OIDC failed — post a "not supported" comment if we can.
  const repository = process.env.REPOSITORY;
  const issueNumber = process.env.ISSUE_NUMBER;
  const actor = process.env.ACTOR;

  // GH_TOKEN is set by the OIDC exchange step via GITHUB_ENV.
  // If OIDC failed, this is the runner fallback token (read-only) — the comment
  // POST will likely 403. We try anyway and handle failure gracefully.
  const ghToken = process.env.GH_TOKEN;

  if (!repository || !issueNumber || !ghToken) {
    core.warning(
      "OIDC unavailable for fork PR and missing context to post comment. " +
        "This is expected when GitHub restricts id-token permissions for fork workflow runs.",
    );
    return;
  }

  // Check for duplicate comments
  try {
    const resp = await fetchWithRetry(
      `https://api.github.com/repos/${repository}/issues/${issueNumber}/comments?per_page=100&direction=desc`,
      {
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (resp.ok) {
      const comments = (await resp.json()) as Array<{ body?: string }>;
      if (comments.some((c) => c.body?.includes(FORK_COMMENT_MARKER))) {
        core.info("Fork unsupported comment already posted.");
        return;
      }
    }
  } catch {
    // If dedup check fails, proceed to post
  }

  const mention = actor ? `@${actor} ` : "";
  const body =
    `${FORK_COMMENT_MARKER}\n` +
    `${mention}bonk can't run on pull requests from forks due to ` +
    `[GitHub Actions permission restrictions](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect).`;

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

    if (resp.ok) {
      core.info("Posted fork unsupported comment.");
    } else {
      core.warning(`Failed to post fork comment (${resp.status}). Token may be read-only.`);
    }
  } catch (error) {
    core.warning(`Failed to post fork comment: ${error}`);
  }
}

main().catch((error) => {
  // Best-effort step — don't kill the workflow on transient errors.
  core.warning(`Unexpected error in fork-comment: ${error}`);
});
