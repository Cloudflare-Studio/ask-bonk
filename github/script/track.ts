// Start tracking a workflow run and create reaction
// Called by the GitHub Action before running OpenCode

import { getContext, getOidcToken, getApiBaseUrl, core } from "./context";

interface TrackPayload {
  owner: string;
  repo: string;
  run_id: number;
  run_url: string;
  issue_number: number;
  created_at: string;
  comment_id?: number;
  review_comment_id?: number;
  issue_id?: number;
}

interface TrackResponse {
  ok?: boolean;
  error?: string;
}

async function main() {
  const context = getContext();
  const { owner, repo } = context.repo;

  if (!context.issue?.number) {
    core.info("No issue number found, skipping tracking");
    return;
  }

  // This step is gated in action.yml by `steps.oidc.outputs.oidc_failed != 'true'`,
  // so it only runs when the OIDC token was already successfully exchanged for an
  // App token. If OIDC fails here despite that, something is genuinely wrong.
  let oidcToken: string;
  try {
    oidcToken = await getOidcToken();
  } catch (error) {
    core.setFailed(`Failed to get OIDC token: ${error}`);
    return;
  }

  const apiBase = getApiBaseUrl();

  // Build payload
  const payload: TrackPayload = {
    owner,
    repo,
    run_id: context.runId,
    run_url: context.runUrl,
    issue_number: context.issue.number,
    created_at: context.createdAt,
  };

  // Add reaction target based on event type
  switch (context.eventName) {
    case "issue_comment":
      if (context.comment?.id) {
        payload.comment_id = context.comment.id;
      }
      break;
    case "pull_request_review_comment":
      if (context.comment?.id) {
        payload.review_comment_id = context.comment.id;
      }
      break;
    case "issues":
      // issue_id is used by the Worker to create a reaction on the issue itself.
      // The reaction API takes the issue number, not the database ID.
      if (context.issue?.number) {
        payload.issue_id = context.issue.number;
      }
      break;
    case "pull_request":
      // No reaction target — the PR itself is the trigger, not a comment
      break;
    case "pull_request_review":
      // PR reviews don't support reactions via the REST API
      break;
  }

  const response = await fetch(`${apiBase}/api/github/track`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${oidcToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    core.setFailed(`Failed to track Bonk run: ${text}`);
    return;
  }

  const data = (await response.json()) as TrackResponse;

  if (data.error) {
    core.setFailed(`Track failed: ${data.error}`);
    return;
  }

  core.info(`Successfully started tracking run ${context.runId}`);
}

main().catch((error) => {
  core.setFailed(`Unexpected error: ${error}`);
});
