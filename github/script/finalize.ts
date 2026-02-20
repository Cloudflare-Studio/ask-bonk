// Finalize tracking a workflow run
// Called by the GitHub Action after OpenCode completes (with if: always())

import { getContext, getOidcToken, getApiBaseUrl, core } from "./context";
import { fetchWithRetry } from "./http";

async function main() {
  const context = getContext();
  const { owner, repo } = context.repo;
  const rawStatus = process.env.OPENCODE_STATUS || "unknown";

  // When the OpenCode step is "skipped", it means an earlier step (cache,
  // install, etc.) failed — GitHub Actions skips subsequent steps on failure.
  // The finalize step only runs when preflight succeeded and the OpenCode step
  // was *expected* to run, so "skipped" here always indicates an infrastructure
  // failure rather than an intentional skip.
  const status = rawStatus === "skipped" ? "failure" : rawStatus;

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
    const response = await fetchWithRetry(`${apiBase}/api/github/track`, {
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
      core.warning(`Failed to finalize Bonk run tracking: ${await response.text()}`);
      return;
    }

    const statusInfo = rawStatus !== status ? `${status} (was ${rawStatus})` : status;
    core.info(`Successfully finalized run ${context.runId} with status ${statusInfo}`);
  } catch (error) {
    // Don't fail on finalize errors
    core.warning(`Failed to finalize Bonk run tracking: ${error}`);
  }
}

main().catch((error) => {
  // Don't fail the workflow on finalize errors
  core.warning(`Unexpected error in finalize: ${error}`);
});
