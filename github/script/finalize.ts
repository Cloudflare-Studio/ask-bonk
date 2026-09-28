// Finalize tracking a workflow run
// Called by the GitHub Action after OpenCode completes (with if: always())

import { pathToFileURL } from "url";
import { getContext, getOidcToken, getApiBaseUrl, core } from "./context";
import { fetchWithRetry } from "./http";

export function resolveFinalizeStatus(env: Record<string, string | undefined>): string {
  const rawStatus = env.OPENCODE_STATUS || "unknown";
  if (rawStatus === "success") return rawStatus;

  // run-opencode.ts exits 124 when its own time budget runs out.
  if (env.OPENCODE_EXIT_CODE === "124") return "timeout";

  // JOB_STATUS is `job.status`. On job cancellation the runner marks the job
  // cancelled before re-evaluating composite steps, so a run cancelled before
  // or during OpenCode reports "cancelled" even though GitHub marks the
  // not-yet-started OpenCode step "skipped".
  if (env.JOB_STATUS === "cancelled") return "cancelled";

  // Otherwise "skipped" means an earlier step (install, etc.) failed. The
  // finalize step only runs when preflight succeeded and the OpenCode step was
  // *expected* to run, so this is an infrastructure failure rather than an
  // intentional skip.
  return rawStatus === "skipped" ? "failure" : rawStatus;
}

async function main() {
  const context = getContext();
  const { owner, repo } = context.repo;
  const rawStatus = process.env.OPENCODE_STATUS || "unknown";
  const status = resolveFinalizeStatus(process.env);
  if (process.env.OPENCODE_FAILURE_CAUSE) {
    core.info(`OpenCode failure cause: ${process.env.OPENCODE_FAILURE_CAUSE}`);
  }

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
        // Include context so the server can post failure comments even if the
        // run was never tracked or was already removed from activeRuns.
        issue_number: context.issue?.number,
        run_url: context.runUrl,
        failure_comment: process.env.FAILURE_COMMENT !== "false",
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Don't fail the workflow on finalize errors
    core.warning(`Unexpected error in finalize: ${error}`);
  });
}
