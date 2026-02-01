// Check if workflow file exists, create PR if not
// Called by the GitHub Action before running OpenCode

import { getContext, getOidcToken, getApiBaseUrl, core } from "./context";

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

  if (!issueNumber) {
    core.info("No issue number found, skipping setup check");
    core.setOutput("skip", "false");
    return;
  }

  let oidcToken: string;
  try {
    oidcToken = await getOidcToken();
  } catch (error) {
    core.setFailed(`Failed to get OIDC token: ${error}`);
    return; // setFailed exits, but explicit return for type safety
  }

  const apiBase = getApiBaseUrl();

  const response = await fetch(`${apiBase}/api/github/setup`, {
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
