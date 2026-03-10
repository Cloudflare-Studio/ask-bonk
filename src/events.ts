import type { PullRequestReviewCommentEvent } from "@octokit/webhooks-types";
import {
  DEFAULT_MODEL,
  type Env,
  type ReviewCommentContext,
  type WorkflowRunContext,
  type WorkflowRunPayload,
} from "./types";

export function extractPrompt(body: string, reviewContext?: ReviewCommentContext): string {
  const trimmed = body.trim();

  if (reviewContext) {
    return `${trimmed}\n\nContext: You are reviewing a comment on file "${reviewContext.file}" at line ${reviewContext.line}.\n\nDiff context:\n${reviewContext.diffHunk}`;
  }

  return trimmed;
}

export function getReviewCommentContext(
  payload: PullRequestReviewCommentEvent,
): ReviewCommentContext {
  return {
    file: payload.comment.path,
    diffHunk: payload.comment.diff_hunk,
    line: payload.comment.line ?? null,
    originalLine: payload.comment.original_line ?? null,
    position: payload.comment.position ?? null,
    commitId: payload.comment.commit_id,
    originalCommitId: payload.comment.original_commit_id,
  };
}

// A null/missing head repo (deleted fork) is treated as a fork.
export function detectFork(
  headRepoFullName: string | undefined | null,
  baseRepoFullName: string | undefined | null,
): boolean {
  return !headRepoFullName || headRepoFullName !== baseRepoFullName;
}

export function getModel(env: Env): { providerID: string; modelID: string } {
  const model = env.DEFAULT_MODEL ?? DEFAULT_MODEL;
  const [providerID, ...rest] = model.split("/");
  const modelID = rest.join("/");

  if (!providerID?.length || !modelID.length) {
    throw new Error(`Invalid model ${model}. Model must be in the format "provider/model".`);
  }

  return { providerID, modelID };
}

export function formatResponse(
  response: string,
  changedFiles: string[] | null,
  sessionLink: string | null,
  model: string,
): string {
  const parts: string[] = [response];

  if (changedFiles && changedFiles.length > 0) {
    parts.push("");
    parts.push("<details>");
    parts.push("<summary>Files changed</summary>");
    parts.push("");
    for (const file of changedFiles) {
      parts.push(`- \`${file}\``);
    }
    parts.push("");
    parts.push("</details>");
  }

  parts.push("");
  parts.push("---");

  const footerParts: string[] = [];
  if (sessionLink) {
    footerParts.push(`[View session](${sessionLink})`);
  }
  footerParts.push(`\`${model}\``);

  parts.push(footerParts.join(" | "));

  return parts.join("\n");
}

export function generateBranchName(type: "issue" | "pr", issueNumber: number): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:-]/g, "")
    .replace(/\.\d{3}Z/, "")
    .split("T")
    .join("");
  return `bonk/${type}${issueNumber}-${timestamp}`;
}

// Conclusions that warrant failure handling. We allowlist rather than denylist
// to avoid false positives from conclusions like "neutral" or "stale".
const FAILURE_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);

// Parse workflow_run.completed events for failed Bonk workflows.
// Returns null for non-completed events, successful runs, or non-Bonk workflows.
export function parseWorkflowRunEvent(payload: WorkflowRunPayload): WorkflowRunContext | null {
  if (payload.action !== "completed") return null;

  const run = payload.workflow_run;
  if (!run || !payload.repository) return null;

  if (!run.conclusion || !FAILURE_CONCLUSIONS.has(run.conclusion)) return null;

  return {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    runId: run.id,
    conclusion: run.conclusion,
    workflowName: run.name,
    workflowPath: run.path,
    runUrl: run.html_url,
    triggerEvent: run.event,
    isPrivate: payload.repository.private,
    triggeringActor: run.triggering_actor?.login,
    pullRequestNumbers: run.pull_requests?.map((pr) => pr.number) ?? [],
  };
}
