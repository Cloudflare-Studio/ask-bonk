import type { Sandbox } from "@cloudflare/sandbox";
import type { AgentNamespace } from "agents";
import type { Config } from "@opencode-ai/sdk";
import type { RepoAgent } from "./agent";

// Default model used across the application when no model is specified
export const DEFAULT_MODEL = "opencode/claude-opus-4-5";

// Environment bindings
export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  REPO_AGENT: AgentNamespace<RepoAgent>;
  APP_INSTALLATIONS: KVNamespace;
  RATE_LIMITER: RateLimit;
  // Workers Analytics Engine for metrics
  BONK_EVENTS: AnalyticsEngineDataset;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  OPENCODE_API_KEY: string;
  DEFAULT_MODEL: string;
  // Shared secret for /ask endpoint - empty means endpoint is disabled
  ASK_SECRET?: string;
  // Allowed orgs/users for GitHub App installation - JSON array binding
  ALLOWED_ORGS: string[];
  // Analytics Engine query API credentials (for /stats endpoint)
  CLOUDFLARE_ACCOUNT_ID?: string;
  ANALYTICS_TOKEN?: string;
  // Enable PAT-to-installation-token exchange (for local development/testing)
  // Set to "true" to enable - disabled by default in production
  ENABLE_PAT_EXCHANGE?: string;
}

// Request body for /ask endpoint
// Runs OpenCode in the sandbox and returns SSE response
export interface AskRequest {
  // ULID assigned when request is received - used for tracing
  id: string;
  owner: string;
  repo: string;
  prompt: string;
  agent?: string;
  model?: string;
  // Provider-specific reasoning effort level (e.g., "high", "max", "minimal").
  // Maps to OpenCode's variant parameter on session.prompt().
  variant?: string;
  // Valid opencode.json/jsonc config to pass into the OpenCode session
  config?: Config;
}

// Context passed through event handling
export interface EventContext {
  env: Env;
  owner: string;
  repo: string;
  issueNumber: number;
  commentId: number;
  actor: string;
  isPullRequest: boolean;
  isPrivate: boolean;
  defaultBranch: string;
  headBranch?: string;
  headSha?: string;
  isFork?: boolean;
}

// Image data extracted from comments
export interface ImageData {
  filename: string;
  mime: string;
  content: string;
  start: number;
  end: number;
  replacement: string;
}

// GraphQL response types for issues
export interface GitHubAuthor {
  login: string;
  name?: string;
}

export interface GitHubComment {
  id: string;
  databaseId: string;
  body: string;
  author: GitHubAuthor;
  createdAt: string;
}

export interface GitHubReviewComment extends GitHubComment {
  path: string;
  line: number | null;
}

export interface GitHubIssue {
  title: string;
  body: string;
  author: GitHubAuthor;
  createdAt: string;
  state: string;
  comments: {
    nodes: GitHubComment[];
  };
}

export interface GitHubCommit {
  oid: string;
  message: string;
  author: {
    name: string;
    email: string;
  };
}

export interface GitHubFile {
  path: string;
  additions: number;
  deletions: number;
  changeType: string;
}

export interface GitHubReview {
  id: string;
  databaseId: string;
  author: GitHubAuthor;
  body: string;
  state: string;
  submittedAt: string;
  comments: {
    nodes: GitHubReviewComment[];
  };
}

export interface GitHubPullRequest {
  title: string;
  body: string;
  author: GitHubAuthor;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  createdAt: string;
  additions: number;
  deletions: number;
  state: string;
  baseRepository: {
    nameWithOwner: string;
  };
  headRepository: {
    nameWithOwner: string;
  };
  commits: {
    totalCount: number;
    nodes: Array<{
      commit: GitHubCommit;
    }>;
  };
  files: {
    nodes: GitHubFile[];
  };
  comments: {
    nodes: GitHubComment[];
  };
  reviews: {
    nodes: GitHubReview[];
  };
}

export interface IssueQueryResponse {
  repository: {
    issue: GitHubIssue;
  };
}

export interface PullRequestQueryResponse {
  repository: {
    pullRequest: GitHubPullRequest;
  };
}

// Review comment context for PR line comments
export interface ReviewCommentContext {
  file: string;
  diffHunk: string;
  line: number | null;
  originalLine: number | null;
  position: number | null;
  commitId: string;
  originalCommitId: string;
}

// Context for scheduled events (no actor, no issue/PR)
export interface ScheduledEventContext {
  owner: string;
  repo: string;
  isPrivate: boolean;
  defaultBranch: string;
  schedule: string;
  workflow: string | null;
}

// Context for workflow_dispatch events (manual trigger, has sender but no issue/PR)
export interface WorkflowDispatchContext {
  owner: string;
  repo: string;
  isPrivate: boolean;
  defaultBranch: string;
  ref: string;
  sender: string;
  inputs: Record<string, string>;
  workflow: string | null;
}

// GitHub schedule event payload structure (minimal type: only fields we use)
export interface ScheduleEventPayload {
  schedule: string;
  repository: {
    owner: { login: string };
    name: string;
    private: boolean;
    default_branch: string;
  };
  workflow?: string;
}

// GitHub workflow_dispatch event payload structure (minimal type: only fields we use)
export interface WorkflowDispatchPayload {
  // inputs can be null if workflow defines no inputs
  inputs?: Record<string, string>;
  ref: string;
  repository: {
    owner: { login: string };
    name: string;
    private: boolean;
    default_branch: string;
  };
  sender: { login: string };
  workflow?: string;
}

// GitHub workflow_run event payload structure (minimal type: only fields we use)
export interface WorkflowRunPayload {
  action: string;
  workflow_run: {
    id: number;
    name: string;
    // Workflow file path relative to repo root, e.g. ".github/workflows/bonk.yml"
    path: string;
    status: string;
    conclusion: string | null;
    html_url: string;
    event: string;
    head_branch: string;
    triggering_actor?: { login: string };
    // Associated PRs - populated for same-repo PRs, empty for fork PRs.
    pull_requests?: Array<{ number: number }>;
  };
  repository: {
    owner: { login: string };
    name: string;
    full_name: string;
    private: boolean;
  };
  sender: { login: string };
}

// Parsed context from a workflow_run webhook event
export interface WorkflowRunContext {
  owner: string;
  repo: string;
  runId: number;
  conclusion: string | null;
  workflowName: string;
  // Workflow file path, e.g. ".github/workflows/bonk.yml"
  workflowPath: string;
  runUrl: string;
  triggerEvent: string;
  isPrivate: boolean;
  triggeringActor?: string;
  // PR numbers from the workflow_run payload (empty for fork PRs)
  pullRequestNumbers: number[];
}

// Request to start tracking a workflow run (POST /api/github/track)
export interface TrackWorkflowRequest {
  owner: string;
  repo: string;
  run_id: number;
  run_url: string;
  issue_number: number;
  created_at: string; // RFC3339
  // For creating reactions - set based on event type
  comment_id?: number; // For issue_comment events
  review_comment_id?: number; // For pull_request_review_comment events
  issue_id?: number; // For issues events — the issue *number* (not database ID) for reactions
}

// Request to finalize a tracked workflow run (PUT /api/github/track)
export interface FinalizeWorkflowRequest {
  owner: string;
  repo: string;
  run_id: number;
  status: "success" | "failure" | "cancelled" | "skipped";
}

// Request to check/create workflow file (POST /api/github/setup)
export interface SetupWorkflowRequest {
  owner: string;
  repo: string;
  issue_number: number;
  default_branch: string;
}
