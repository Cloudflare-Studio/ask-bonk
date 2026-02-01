// Finalize tracking a workflow run
// Called by the GitHub Action after OpenCode completes (with if: always())

import { getContext, getOidcToken, getApiBaseUrl, core } from "./context";

async function main() {
  const context = getContext();
  const { owner, repo } = context.repo;
  const status = process.env.OPENCODE_STATUS || "unknown";

  let oidcToken: string;
  try {
    oidcToken = await getOidcToken();
  } catch (error) {
    // Don't fail the workflow on finalize errors - just warn
    core.warning(`Failed to get OIDC token for finalize: ${error}`);
    return;
  }

  const apiBase = getApiBaseUrl();

  try {
    const response = await fetch(`${apiBase}/api/github/track`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        owner,
        repo,
        run_id: context.runId,
        status,
      }),
    });

    if (!response.ok) {
      core.warning(
        `Failed to finalize Bonk run tracking: ${await response.text()}`,
      );
      return;
    }

    core.info(
      `Successfully finalized run ${context.runId} with status ${status}`,
    );
  } catch (error) {
    // Don't fail on finalize errors
    core.warning(`Failed to finalize Bonk run tracking: ${error}`);
  }
}

main().catch((error) => {
  // Don't fail the workflow on finalize errors
  core.warning(`Unexpected error in finalize: ${error}`);
});
