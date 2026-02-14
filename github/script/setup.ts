// Check if workflow file exists, create PR if not
// Called by the GitHub Action before running OpenCode

import { getContext, getOidcToken, getApiBaseUrl, detectForkFromPR, core } from "./context";
import { fetchWithRetry } from "./http";

interface SetupResponse {
  exists: boolean;
  prUrl?: string;
  error?: string;
}

async function detectForkInSetup(): Promise<boolean | null> {
  const result = await detectForkFromPR(
    process.env.PR_HEAD_REPO,
    process.env.PR_BASE_REPO,
    process.env.PR_URL,
    process.env.SETUP_GH_TOKEN,
  );
  return result?.isFork ?? null;
}

async function main() {
  const context = getContext();
  const { owner, repo } = context.repo;
  const issueNumber = context.issue?.number;
  const defaultBranch = context.defaultBranch;
  const eventName = process.env.EVENT_NAME || "";

  if (!issueNumber) {
    if (
      eventName === "pull_request" ||
      eventName === "pull_request_review" ||
      eventName === "pull_request_review_comment" ||
      eventName === "issue_comment" ||
      eventName === "issues"
    ) {
      core.setFailed("No issue number found for PR/issue event; cannot run setup check");
      return;
    }
    core.info("No issue number found, skipping setup check");
    core.setOutput("skip", "false");
    return;
  }

  // OIDC requires the `id-token: write` permission, which GitHub doesn't
  // grant when a workflow needs maintainer approval (fork PRs, first-time
  // contributors). When OIDC is unavailable, skip the setup check and let
  // the action continue — the OIDC step in action.yml handles the fallback.
  let oidcToken: string;
  try {
    oidcToken = await getOidcToken();
  } catch (error) {
    const oidcAvailable =
      !!process.env.ACTIONS_ID_TOKEN_REQUEST_URL && !!process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (oidcAvailable) {
      core.setFailed(`OIDC token exchange failed unexpectedly: ${error}`);
      return;
    }
    const isFork = await detectForkInSetup();
    if (isFork === true) {
      core.warning("OIDC not available for fork PR, skipping setup check");
      core.setOutput("skip", "false");
      return;
    }
    if (isFork === false) {
      core.setFailed("OIDC not available for non-fork PR. Ensure id-token: write is configured.");
      return;
    }
    // isFork === null: fork status unknown. Fail closed.
    core.setFailed("OIDC not available and fork status could not be determined.");
    return;
  }

  const apiBase = getApiBaseUrl();

  let response: Response;
  try {
    response = await fetchWithRetry(`${apiBase}/api/github/setup`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        owner,
        repo,
        issue_number: issueNumber,
        default_branch: defaultBranch,
      }),
    });
  } catch (error) {
    core.setFailed(`Setup request failed: ${error}`);
    return;
  }

  if (!response.ok) {
    const text = await response.text();
    core.setFailed(`Setup request failed: ${text}`);
    return;
  }

  const data = (await response.json()) as SetupResponse;

  if (data.error) {
    core.setFailed(`Setup failed: ${data.error}`);
    return;
  }

  if (data.exists) {
    core.info("Workflow file exists");
    core.setOutput("skip", "false");
  } else {
    core.info(`Workflow file missing - PR created: ${data.prUrl}`);
    core.setOutput("skip", "true");
    core.setOutput("pr_url", data.prUrl || "");
  }
}

main().catch((error) => {
  core.setFailed(`Unexpected error: ${error}`);
});
