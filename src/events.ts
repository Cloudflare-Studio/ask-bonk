import type {
  IssueCommentEvent,
  IssuesEvent,
  PullRequestEvent,
  PullRequestReviewCommentEvent,
  PullRequestReviewEvent,
} from "@octokit/webhooks-types";
import {
  DEFAULT_MODEL,
  type Env,
  type EventContext,
  type ReviewCommentContext,
  type ScheduledEventContext,
  type WorkflowDispatchContext,
  type WorkflowRunContext,
  type ScheduleEventPayload,
  type WorkflowDispatchPayload,
  type WorkflowRunPayload,
} from "./types";
import { log } from "./log";

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

function isForkPR(
  payload: IssueCommentEvent | PullRequestReviewCommentEvent | PullRequestReviewEvent,
): boolean {
  if ("pull_request" in payload && payload.pull_request) {
    const pr = payload.pull_request;
    if ("head" in pr && "base" in pr) {
      const head = pr.head as { repo?: { full_name?: string } | null };
      const base = pr.base as { repo?: { full_name?: string } | null };
      return detectFork(head.repo?.full_name, base.repo?.full_name);
    }
  }
  return false;
}

// Parse issue comment events - no mention filtering, that's handled by the action
export function parseIssueCommentEvent(payload: IssueCommentEvent): {
  context: Omit<EventContext, "env">;
  prompt: string;
  triggerCommentId: number;
} | null {
  if (payload.action !== "created") {
    return null;
  }

  const isPullRequest = Boolean(payload.issue.pull_request);

  return {
    context: {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issueNumber: payload.issue.number,
      commentId: 0, // Will be set after creating response comment
      actor: payload.comment.user.login,
      isPullRequest,
      isPrivate: payload.repository.private,
      defaultBranch: payload.repository.default_branch,
    },
    prompt: extractPrompt(payload.comment.body),
    triggerCommentId: payload.comment.id,
  };
}

// Parse PR review comment events - no mention filtering, that's handled by the action
export function parsePRReviewCommentEvent(payload: PullRequestReviewCommentEvent): {
  context: Omit<EventContext, "env">;
  prompt: string;
  triggerCommentId: number;
  reviewContext: ReviewCommentContext;
} | null {
  if (payload.action !== "created") {
    return null;
  }

  const fork = isForkPR(payload);
  const reviewContext = getReviewCommentContext(payload);

  return {
    context: {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issueNumber: payload.pull_request.number,
      commentId: 0,
      actor: payload.comment.user.login,
      isPullRequest: true,
      isPrivate: payload.repository.private,
      defaultBranch: payload.repository.default_branch,
      headBranch: payload.pull_request.head.ref,
      headSha: payload.pull_request.head.sha,
      isFork: fork,
    },
    prompt: extractPrompt(payload.comment.body, reviewContext),
    triggerCommentId: payload.comment.id,
    reviewContext,
  };
}

// Parse PR review events - no mention filtering, that's handled by the action
export function parsePRReviewEvent(payload: PullRequestReviewEvent): {
  context: Omit<EventContext, "env">;
  prompt: string;
  triggerCommentId: number;
} | null {
  if (payload.action !== "submitted") {
    return null;
  }

  if (!payload.review.body) {
    return null;
  }

  const fork = isForkPR(payload);

  return {
    context: {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issueNumber: payload.pull_request.number,
      commentId: 0,
      actor: payload.review.user.login,
      isPullRequest: true,
      isPrivate: payload.repository.private,
      defaultBranch: payload.repository.default_branch,
      headBranch: payload.pull_request.head.ref,
      headSha: payload.pull_request.head.sha,
      isFork: fork,
    },
    prompt: extractPrompt(payload.review.body),
    triggerCommentId: payload.review.id,
  };
}

// Parse issues events - supports 'opened' and 'edited' actions.
// Both are processed the same way - filtering logic is handled by the workflow.
// Other actions (deleted, labeled, etc.) are explicitly rejected.
export function parseIssuesEvent(payload: IssuesEvent): {
  context: Omit<EventContext, "env">;
  issueTitle: string;
  issueBody: string;
  issueAuthor: string;
} | null {
  if (payload.action === "opened" || payload.action === "edited") {
    return {
      context: {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        issueNumber: payload.issue.number,
        commentId: 0,
        actor: payload.action === "opened" ? payload.issue.user.login : payload.sender.login,
        isPullRequest: false,
        isPrivate: payload.repository.private,
        defaultBranch: payload.repository.default_branch,
      },
      issueTitle: payload.issue.title,
      issueBody: payload.issue.body ?? "",
      issueAuthor: payload.issue.user.login,
    };
  }

  log.info("issues_event_unsupported_action", { action: payload.action });
  return null;
}

// Parse pull_request events - all actions pass through (no filtering).
// Action filtering is the workflow's responsibility.
export function parsePullRequestEvent(payload: PullRequestEvent): {
  context: Omit<EventContext, "env">;
  action: string;
} {
  const isFork = detectFork(
    payload.pull_request.head.repo?.full_name,
    payload.pull_request.base.repo?.full_name,
  );

  return {
    context: {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issueNumber: payload.pull_request.number,
      commentId: 0,
      actor: payload.sender.login,
      isPullRequest: true,
      isPrivate: payload.repository.private,
      defaultBranch: payload.repository.default_branch,
      headBranch: payload.pull_request.head.ref,
      headSha: payload.pull_request.head.sha,
      isFork,
    },
    action: payload.action,
  };
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

export function parseScheduleEvent(payload: ScheduleEventPayload): ScheduledEventContext | null {
  if (!payload.schedule || !payload.repository) {
    return null;
  }

  return {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    isPrivate: payload.repository.private,
    defaultBranch: payload.repository.default_branch,
    schedule: payload.schedule,
    workflow: payload.workflow ?? null,
  };
}

export function parseWorkflowDispatchEvent(
  payload: WorkflowDispatchPayload,
): WorkflowDispatchContext | null {
  if (!payload.repository || !payload.ref) {
    return null;
  }

  return {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    isPrivate: payload.repository.private,
    defaultBranch: payload.repository.default_branch,
    ref: payload.ref,
    sender: payload.sender.login,
    inputs: payload.inputs ?? {},
    workflow: payload.workflow ?? null,
  };
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
