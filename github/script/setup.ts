// Check if workflow file exists, create PR if not
// Called by the GitHub Action before running OpenCode

import { getContext, getOidcToken, getApiBaseUrl, core } from "./context";
import { fetchWithRetry } from "./http";

interface SetupResponse {
  exists: boolean;
  prUrl?: string;
  error?: string;
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
      core.setFailed(
        "No issue number found for PR/issue event; cannot run setup check",
      );
      return;
    }
    core.info("No issue number found, skipping setup check");
    core.setOutput("skip", "false");
    return;
  }

  // Get OIDC token for the setup check. If unavailable (e.g. fork PRs where
  // GitHub strips id-token permissions), skip the check — fork handling and
  // OIDC exchange happen in later steps.
  let oidcToken: string;
  try {
    oidcToken = await getOidcToken();
  } catch (error) {
    const oidcAvailable =
      !!process.env.ACTIONS_ID_TOKEN_REQUEST_URL &&
      !!process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (oidcAvailable) {
      core.setFailed(`OIDC token exchange failed unexpectedly: ${error}`);
      return;
    }
    // OIDC credentials not present — skip setup check and let the OIDC
    // exchange step in action.yml handle success/failure.
    core.warning("OIDC not available, skipping setup check");
    core.setOutput("skip", "false");
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
