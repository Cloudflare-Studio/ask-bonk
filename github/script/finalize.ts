// Finalize tracking a workflow run
// Called by the GitHub Action after OpenCode completes (with if: always())

import { getContext, getOidcToken, getApiBaseUrl, core, getErrorMessage } from "./context";
import { fetchWithRetry } from "./http";

function parseOptionalNumberEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalStringEnv(value: string | undefined): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  return value;
}

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

  const exitCode = parseOptionalNumberEnv(process.env.OPENCODE_EXIT_CODE);
  const attemptCount = parseOptionalNumberEnv(process.env.OPENCODE_ATTEMPT_COUNT);
  const finalReason = parseOptionalStringEnv(process.env.OPENCODE_FINAL_REASON);

  let oidcToken: string;
  try {
    oidcToken = await getOidcToken();
  } catch (error) {
    // Don't fail the workflow on finalize errors - just warn
    core.warning(`Failed to get OIDC token for finalize: ${getErrorMessage(error)}`);
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
        // Retry metadata from the resilient wrapper.
        ...(exitCode !== undefined && { exit_code: exitCode }),
        ...(attemptCount !== undefined && { attempt_count: attemptCount }),
        ...(finalReason !== undefined && { final_reason: finalReason }),
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
    core.warning(`Failed to finalize Bonk run tracking: ${getErrorMessage(error)}`);
  }
}

main().catch((error) => {
  // Don't fail the workflow on finalize errors
  core.warning(`Unexpected error in finalize: ${getErrorMessage(error)}`);
});
