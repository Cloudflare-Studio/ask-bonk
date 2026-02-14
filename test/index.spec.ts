import { describe, it, expect } from "vitest";
import {
  extractPrompt,
  detectFork,
  parseIssueCommentEvent,
  parsePRReviewCommentEvent,
  parsePRReviewEvent,
  parsePullRequestEvent,
  parseScheduleEvent,
  parseIssuesEvent,
  parseWorkflowDispatchEvent,
  parseWorkflowRunEvent,
  getModel,
  formatResponse,
  generateBranchName,
} from "../src/events";
import {
  extractRepoFromClaims,
  handleExchangeTokenForRepo,
  handleExchangeTokenWithPAT,
} from "../src/oidc";
import { sanitizeSecrets } from "../src/log";
import type { Env } from "../src/types";
import type {
  ScheduleEventPayload,
  WorkflowDispatchPayload,
  WorkflowRunPayload,
} from "../src/types";
import type {
  IssueCommentEvent,
  IssuesEvent,
  PullRequestEvent,
  PullRequestReviewCommentEvent,
  PullRequestReviewEvent,
} from "@octokit/webhooks-types";

// Read fixtures
import issueCommentFixture from "./fixtures/issue-comment.json";
import prReviewCommentFixture from "./fixtures/pr-review-comment.json";

// Proxy-based mock Env that throws on unexpected property access.
// Ensures tests only touch properties they explicitly provide, preventing
// silent undefined returns from missing stubs.
function createMockEnv(overrides: Partial<Env> = {}): Env {
  const values: Record<string, unknown> = {
    APP_INSTALLATIONS: {
      get: async () => null,
      put: async () => {},
    },
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "test-key",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    OPENCODE_API_KEY: "test-api-key",
    DEFAULT_MODEL: "anthropic/claude-opus-4-5",
    ALLOWED_ORGS: [],
    ...overrides,
  };

  return new Proxy(values as unknown as Env, {
    get(target, prop, receiver) {
      // Allow symbols, serialization helpers, and thenable checks (Promise.resolve probes .then)
      if (typeof prop === "symbol" || prop === "toJSON" || prop === "then") {
        return Reflect.get(target, prop, receiver);
      }
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      // Optional Env fields (marked with `?` in the Env interface) don't need stubs
      if (
        prop === "ASK_SECRET" ||
        prop === "CLOUDFLARE_ACCOUNT_ID" ||
        prop === "ANALYTICS_TOKEN" ||
        prop === "ENABLE_PAT_EXCHANGE"
      ) {
        return undefined;
      }
      throw new Error(
        `Mock Env: unexpected property access "${String(prop)}". Add it to createMockEnv overrides.`,
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Fork Detection (tested once, directly against the exported helper)
// ---------------------------------------------------------------------------

describe("Fork Detection", () => {
  it.each([
    {
      head: "forked-owner/repo",
      base: "owner/repo",
      expected: true,
      label: "different full_name",
    },
    {
      head: "owner/repo",
      base: "owner/repo",
      expected: false,
      label: "same full_name",
    },
    { head: null, base: "owner/repo", expected: true, label: "null head repo" },
    {
      head: undefined,
      base: "owner/repo",
      expected: true,
      label: "undefined head repo",
    },
    { head: "", base: "owner/repo", expected: true, label: "empty head repo" },
  ])("$label → $expected", ({ head, base, expected }) => {
    expect(detectFork(head, base)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Prompt Extraction
// ---------------------------------------------------------------------------

describe("Prompt Extraction", () => {
  it("extracts full prompt", () => {
    const prompt = extractPrompt("@ask-bonk fix the type error");
    expect(prompt).toBe("@ask-bonk fix the type error");
  });

  it("returns prompt as-is for bare mention", () => {
    const prompt = extractPrompt("@ask-bonk");
    expect(prompt).toBe("@ask-bonk");
  });

  it("includes review context when provided", () => {
    const reviewContext = {
      file: "src/utils.ts",
      diffHunk: "@@ -1,3 +1,4 @@\n+const x = 1;",
      line: 5,
      originalLine: 4,
      position: 2,
      commitId: "abc123",
      originalCommitId: "def456",
    };
    const prompt = extractPrompt("@ask-bonk improve this", reviewContext);
    expect(prompt).toContain("src/utils.ts");
    expect(prompt).toContain("line 5");
  });
});

// ---------------------------------------------------------------------------
// Issue Comment Event Parsing
// ---------------------------------------------------------------------------

describe("Issue Comment Event Parsing", () => {
  it("parses valid issue comment event", () => {
    const result = parseIssueCommentEvent(issueCommentFixture as unknown as IssueCommentEvent);

    expect(result).not.toBeNull();
    expect(result?.context.owner).toBe("test-owner");
    expect(result?.context.repo).toBe("test-repo");
    expect(result?.context.issueNumber).toBe(42);
    expect(result?.context.actor).toBe("testuser");
    expect(result?.context.isPullRequest).toBe(false);
    expect(result?.triggerCommentId).toBe(123456);
  });

  it("returns null for non-created action", () => {
    const payload = { ...issueCommentFixture, action: "deleted" };
    const result = parseIssueCommentEvent(payload as unknown as IssueCommentEvent);
    expect(result).toBeNull();
  });

  it("parses comments without mention (filtering is done by action)", () => {
    const payload = {
      ...issueCommentFixture,
      comment: {
        ...issueCommentFixture.comment,
        body: "just a regular comment",
      },
    };
    const result = parseIssueCommentEvent(payload as unknown as IssueCommentEvent);
    expect(result).not.toBeNull();
    expect(result?.prompt).toBe("just a regular comment");
  });
});

// ---------------------------------------------------------------------------
// PR Review Comment Event Parsing
// ---------------------------------------------------------------------------

describe("PR Review Comment Event Parsing", () => {
  it("parses valid PR review comment event", () => {
    const result = parsePRReviewCommentEvent(
      prReviewCommentFixture as unknown as PullRequestReviewCommentEvent,
    );

    expect(result).not.toBeNull();
    expect(result?.context.owner).toBe("test-owner");
    expect(result?.context.repo).toBe("test-repo");
    expect(result?.context.issueNumber).toBe(99);
    expect(result?.context.isPullRequest).toBe(true);
    expect(result?.context.headBranch).toBe("feature-branch");
    expect(result?.reviewContext.file).toBe("src/utils.ts");
    expect(result?.reviewContext.line).toBe(42);
  });

  it("wires fork detection through to context", () => {
    const forkPayload = {
      ...prReviewCommentFixture,
      pull_request: {
        ...prReviewCommentFixture.pull_request,
        head: {
          ...prReviewCommentFixture.pull_request.head,
          repo: { full_name: "forked-owner/test-repo" },
        },
      },
    };
    const result = parsePRReviewCommentEvent(
      forkPayload as unknown as PullRequestReviewCommentEvent,
    );
    expect(result?.context.isFork).toBe(true);

    // Same-repo should be false
    const sameRepo = parsePRReviewCommentEvent(
      prReviewCommentFixture as unknown as PullRequestReviewCommentEvent,
    );
    expect(sameRepo?.context.isFork).toBe(false);
  });

  it("preserves head metadata when head.repo is null", () => {
    const payload = {
      ...prReviewCommentFixture,
      pull_request: {
        ...prReviewCommentFixture.pull_request,
        head: {
          ...prReviewCommentFixture.pull_request.head,
          repo: null,
        },
      },
    };
    const result = parsePRReviewCommentEvent(payload as unknown as PullRequestReviewCommentEvent);
    expect(result?.context.isFork).toBe(true);
    expect(result?.context.headBranch).toBe("feature-branch");
    expect(result?.context.headSha).toBe("abc123");
  });
});

// ---------------------------------------------------------------------------
// PR Review Event Parsing
// ---------------------------------------------------------------------------

describe("PR Review Event Parsing", () => {
  const basePRReviewPayload = {
    action: "submitted",
    review: {
      id: 111222,
      body: "/bonk review this",
      user: { login: "reviewer" },
    },
    pull_request: {
      number: 99,
      head: {
        ref: "feature-branch",
        sha: "abc123",
        repo: { full_name: "test-owner/test-repo" },
      },
      base: {
        repo: { full_name: "test-owner/test-repo" },
      },
    },
    repository: {
      name: "test-repo",
      owner: { login: "test-owner" },
      private: false,
      default_branch: "main",
    },
    installation: { id: 12345 },
  };

  it("wires fork detection through to context", () => {
    const forkPayload = {
      ...basePRReviewPayload,
      pull_request: {
        ...basePRReviewPayload.pull_request,
        head: {
          ...basePRReviewPayload.pull_request.head,
          repo: { full_name: "forked-owner/test-repo" },
        },
      },
    };
    const result = parsePRReviewEvent(forkPayload as unknown as PullRequestReviewEvent);
    expect(result?.context.isFork).toBe(true);

    const sameRepo = parsePRReviewEvent(basePRReviewPayload as unknown as PullRequestReviewEvent);
    expect(sameRepo?.context.isFork).toBe(false);
  });

  it("preserves head metadata when head.repo is null", () => {
    const payload = {
      ...basePRReviewPayload,
      pull_request: {
        ...basePRReviewPayload.pull_request,
        head: {
          ...basePRReviewPayload.pull_request.head,
          repo: null,
        },
      },
    };
    const result = parsePRReviewEvent(payload as unknown as PullRequestReviewEvent);
    expect(result?.context.isFork).toBe(true);
    expect(result?.context.headBranch).toBe("feature-branch");
    expect(result?.context.headSha).toBe("abc123");
  });
});

// ---------------------------------------------------------------------------
// Model Configuration (table-driven)
// ---------------------------------------------------------------------------

describe("Model Configuration", () => {
  it.each([
    {
      input: "anthropic/claude-opus-4-5",
      provider: "anthropic",
      model: "claude-opus-4-5",
    },
    {
      input: "opencode/claude-3-5-sonnet-v2",
      provider: "opencode",
      model: "claude-3-5-sonnet-v2",
    },
    {
      input: "google/gemini-2.5-pro",
      provider: "google",
      model: "gemini-2.5-pro",
    },
  ])("parses $input → $provider/$model", ({ input, provider, model }) => {
    const env = createMockEnv({ DEFAULT_MODEL: input });
    const result = getModel(env);
    expect(result.providerID).toBe(provider);
    expect(result.modelID).toBe(model);
  });

  it("returns hardcoded default when no DEFAULT_MODEL", () => {
    const env = createMockEnv({ DEFAULT_MODEL: undefined as unknown as string });
    const result = getModel(env);
    expect(result.providerID).toBe("opencode");
    expect(result.modelID).toBe("claude-opus-4-5");
  });

  it("throws on invalid model format without slash", () => {
    const env = createMockEnv({ DEFAULT_MODEL: "invalid-model" });
    expect(() => getModel(env)).toThrow("Invalid model");
  });
});

// ---------------------------------------------------------------------------
// Response Formatting
// ---------------------------------------------------------------------------

describe("Response Formatting", () => {
  it("formats basic response", () => {
    const response = formatResponse("Here is the fix", null, null, "anthropic/claude-opus-4-5");
    expect(response).toContain("Here is the fix");
    expect(response).toContain("`anthropic/claude-opus-4-5`");
  });

  it("includes changed files", () => {
    const response = formatResponse(
      "Fixed the issue",
      ["src/utils.ts", "src/index.ts"],
      null,
      "anthropic/claude-opus-4-5",
    );
    expect(response).toContain("Files changed");
    expect(response).toContain("`src/utils.ts`");
    expect(response).toContain("`src/index.ts`");
  });

  it("includes session link for public repos", () => {
    const response = formatResponse(
      "Done",
      null,
      "https://opencode.ai/s/abc123",
      "anthropic/claude-opus-4-5",
    );
    expect(response).toContain("[View session](https://opencode.ai/s/abc123)");
  });
});

// ---------------------------------------------------------------------------
// Branch Name Generation
// ---------------------------------------------------------------------------

describe("Branch Name Generation", () => {
  it("generates issue branch name", () => {
    const branch = generateBranchName("issue", 42);
    expect(branch).toMatch(/^bonk\/issue42-\d{14}$/);
  });

  it("generates PR branch name", () => {
    const branch = generateBranchName("pr", 99);
    expect(branch).toMatch(/^bonk\/pr99-\d{14}$/);
  });
});

// ---------------------------------------------------------------------------
// Schedule Event Parsing
// ---------------------------------------------------------------------------

describe("Schedule Event Parsing", () => {
  const validSchedulePayload: ScheduleEventPayload = {
    schedule: "0 4 * * 5",
    repository: {
      owner: { login: "test-owner" },
      name: "test-repo",
      private: false,
      default_branch: "main",
    },
    workflow: "weekly-deps-update.yml",
  };

  it("parses valid schedule event", () => {
    const result = parseScheduleEvent(validSchedulePayload);

    expect(result).not.toBeNull();
    expect(result?.owner).toBe("test-owner");
    expect(result?.repo).toBe("test-repo");
    expect(result?.isPrivate).toBe(false);
    expect(result?.defaultBranch).toBe("main");
    expect(result?.schedule).toBe("0 4 * * 5");
    expect(result?.workflow).toBe("weekly-deps-update.yml");
  });

  it("returns null for missing schedule field", () => {
    const payload = { ...validSchedulePayload, schedule: "" };
    const result = parseScheduleEvent(payload as ScheduleEventPayload);
    expect(result).toBeNull();
  });

  it("handles missing workflow field", () => {
    const payload = { ...validSchedulePayload, workflow: undefined };
    const result = parseScheduleEvent(payload);

    expect(result).not.toBeNull();
    expect(result?.workflow).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Issues Event Parsing
// ---------------------------------------------------------------------------

describe("Issues Event Parsing", () => {
  const baseIssuesPayload = {
    action: "opened",
    issue: {
      number: 42,
      title: "Test Issue",
      body: "Issue body content",
      user: { login: "testuser" },
      created_at: "2025-01-01T00:00:00Z",
    },
    repository: {
      owner: { login: "test-owner" },
      name: "test-repo",
      private: false,
      default_branch: "main",
    },
    sender: { login: "testuser" },
    installation: { id: 12345 },
  } as unknown as IssuesEvent;

  it("parses issues:opened event", () => {
    const result = parseIssuesEvent(baseIssuesPayload);

    expect(result).not.toBeNull();
    expect(result?.context.owner).toBe("test-owner");
    expect(result?.context.repo).toBe("test-repo");
    expect(result?.context.issueNumber).toBe(42);
    expect(result?.context.actor).toBe("testuser");
    expect(result?.issueTitle).toBe("Test Issue");
    expect(result?.issueBody).toBe("Issue body content");
  });

  it("parses issues:edited event", () => {
    const payload = {
      ...baseIssuesPayload,
      action: "edited",
      issue: {
        ...baseIssuesPayload.issue,
        body: "Updated issue content",
      },
      changes: { body: { from: "Old body" } },
    } as unknown as IssuesEvent;

    const result = parseIssuesEvent(payload);
    expect(result).not.toBeNull();
    expect(result?.issueBody).toBe("Updated issue content");
    expect(result?.context.actor).toBe("testuser");
  });

  it("rejects unsupported issue actions", () => {
    const payload = {
      ...baseIssuesPayload,
      action: "deleted",
    } as unknown as IssuesEvent;

    const result = parseIssuesEvent(payload);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pull Request Event Parsing
// ---------------------------------------------------------------------------

describe("Pull Request Event Parsing", () => {
  const basePRData = {
    action: "opened",
    pull_request: {
      number: 55,
      head: {
        ref: "feature-branch",
        sha: "abc123",
        repo: { full_name: "test-owner/test-repo" },
      },
      base: {
        repo: { full_name: "test-owner/test-repo" },
      },
    },
    repository: {
      name: "test-repo",
      owner: { login: "test-owner" },
      private: false,
      default_branch: "main",
    },
    sender: { login: "testuser" },
    installation: { id: 12345 },
  };

  const parse = (data: Record<string, unknown>) =>
    parsePullRequestEvent(data as unknown as PullRequestEvent);

  it("parses pull_request:opened event", () => {
    const result = parse(basePRData);

    expect(result).not.toBeNull();
    expect(result.context.owner).toBe("test-owner");
    expect(result.context.repo).toBe("test-repo");
    expect(result.context.issueNumber).toBe(55);
    expect(result.context.actor).toBe("testuser");
    expect(result.context.isPullRequest).toBe(true);
    expect(result.context.headBranch).toBe("feature-branch");
    expect(result.context.headSha).toBe("abc123");
    expect(result.action).toBe("opened");
  });

  it("passes through all actions without filtering", () => {
    const result = parse({ ...basePRData, action: "synchronize" });
    expect(result.action).toBe("synchronize");
    expect(result.context.issueNumber).toBe(55);
  });

  it("wires fork detection through to context", () => {
    const fork = parse({
      ...basePRData,
      pull_request: {
        ...basePRData.pull_request,
        head: {
          ...basePRData.pull_request.head,
          repo: { full_name: "forked-owner/test-repo" },
        },
      },
    });
    expect(fork.context.isFork).toBe(true);

    const sameRepo = parse(basePRData);
    expect(sameRepo.context.isFork).toBe(false);
  });

  it("preserves head metadata when head.repo is null", () => {
    const result = parse({
      ...basePRData,
      pull_request: {
        ...basePRData.pull_request,
        head: {
          ...basePRData.pull_request.head,
          repo: null,
        },
      },
    });
    expect(result.context.isFork).toBe(true);
    expect(result.context.headBranch).toBe("feature-branch");
    expect(result.context.headSha).toBe("abc123");
  });
});

// ---------------------------------------------------------------------------
// Workflow Dispatch Event Parsing
// ---------------------------------------------------------------------------

describe("Workflow Dispatch Event Parsing", () => {
  const validPayload: WorkflowDispatchPayload = {
    inputs: { prompt: "Run weekly update" },
    ref: "refs/heads/main",
    repository: {
      owner: { login: "test-owner" },
      name: "test-repo",
      private: false,
      default_branch: "main",
    },
    sender: { login: "testuser" },
    workflow: "bonk.yml",
  };

  it("parses valid workflow_dispatch event", () => {
    const result = parseWorkflowDispatchEvent(validPayload);

    expect(result).not.toBeNull();
    expect(result?.owner).toBe("test-owner");
    expect(result?.repo).toBe("test-repo");
    expect(result?.sender).toBe("testuser");
    expect(result?.ref).toBe("refs/heads/main");
    expect(result?.inputs.prompt).toBe("Run weekly update");
  });

  it("returns null for missing ref", () => {
    const payload = { ...validPayload, ref: "" };
    const result = parseWorkflowDispatchEvent(payload as WorkflowDispatchPayload);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Workflow Run Event Parsing (table-driven conclusion filtering)
// ---------------------------------------------------------------------------

describe("Workflow Run Event Parsing", () => {
  const validPayload: WorkflowRunPayload = {
    action: "completed",
    workflow_run: {
      id: 12345,
      name: "Bonk",
      path: ".github/workflows/bonk.yml",
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/test-owner/test-repo/actions/runs/12345",
      event: "issue_comment",
      head_branch: "main",
    },
    repository: {
      owner: { login: "test-owner" },
      name: "test-repo",
      full_name: "test-owner/test-repo",
      private: false,
    },
    sender: { login: "testuser" },
  };

  it("parses valid failure event with all fields", () => {
    const result = parseWorkflowRunEvent(validPayload);

    expect(result).not.toBeNull();
    expect(result?.owner).toBe("test-owner");
    expect(result?.repo).toBe("test-repo");
    expect(result?.runId).toBe(12345);
    expect(result?.conclusion).toBe("failure");
    expect(result?.workflowName).toBe("Bonk");
    expect(result?.workflowPath).toBe(".github/workflows/bonk.yml");
    expect(result?.triggerEvent).toBe("issue_comment");
  });

  it("returns null for non-completed action", () => {
    const payload = { ...validPayload, action: "requested" };
    expect(parseWorkflowRunEvent(payload)).toBeNull();
  });

  // Conclusion allowlist: failure, cancelled, timed_out, action_required are parsed.
  // Everything else returns null.
  it.each([
    { conclusion: "failure", parsed: true },
    { conclusion: "cancelled", parsed: true },
    { conclusion: "timed_out", parsed: true },
    { conclusion: "action_required", parsed: true },
    { conclusion: "success", parsed: false },
    { conclusion: "skipped", parsed: false },
    { conclusion: "neutral", parsed: false },
    { conclusion: "stale", parsed: false },
  ])("conclusion=$conclusion → parsed=$parsed", ({ conclusion, parsed }) => {
    const payload = {
      ...validPayload,
      workflow_run: { ...validPayload.workflow_run, conclusion },
    };
    const result = parseWorkflowRunEvent(payload);
    if (parsed) {
      expect(result).not.toBeNull();
      expect(result?.conclusion).toBe(conclusion);
    } else {
      expect(result).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// OIDC Claim Parsing
// ---------------------------------------------------------------------------

describe("OIDC Claim Parsing", () => {
  it("extracts owner and repo from claims", () => {
    const claims = {
      iss: "https://token.actions.githubusercontent.com",
      sub: "repo:octocat/hello-world:ref:refs/heads/main",
      aud: "opencode-github-action",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      repository: "octocat/hello-world",
      repository_owner: "octocat",
      repository_id: "123456",
      repository_owner_id: "789",
      run_id: "1234567890",
      run_number: "42",
      run_attempt: "1",
      actor: "octocat",
      actor_id: "789",
      workflow: "CI",
      event_name: "push",
      ref: "refs/heads/main",
      ref_type: "branch",
      job_workflow_ref: "octocat/hello-world/.github/workflows/ci.yml@refs/heads/main",
      runner_environment: "github-hosted",
    };

    const result = extractRepoFromClaims(claims);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.owner).toBe("octocat");
      expect(result.value.repo).toBe("hello-world");
    }
  });

  it("handles repos with multiple dashes/underscores", () => {
    const claims = {
      repository: "my-org/my-complex_repo-name",
    } as any;
    const result = extractRepoFromClaims(claims);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.owner).toBe("my-org");
      expect(result.value.repo).toBe("my-complex_repo-name");
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-Repo Token Exchange — auth header validation
// These test early rejection before any OIDC or network calls.
// ---------------------------------------------------------------------------

describe("Cross-Repo Token Exchange Input Validation", () => {
  const testEnv = createMockEnv();

  it("rejects requests without Authorization header", async () => {
    const result = await handleExchangeTokenForRepo(testEnv, null, {
      owner: "test-org",
      repo: "test-repo",
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("Authorization");
    }
  });

  it("rejects requests with non-Bearer Authorization", async () => {
    const result = await handleExchangeTokenForRepo(testEnv, "Basic abc123", {
      owner: "test-org",
      repo: "test-repo",
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("Authorization");
    }
  });
});

// ---------------------------------------------------------------------------
// PAT Exchange Security (table-driven prefix validation)
// ---------------------------------------------------------------------------

describe("PAT Exchange Security", () => {
  const patEnvDisabled = createMockEnv();
  const patEnvEnabled = createMockEnv({ ENABLE_PAT_EXCHANGE: "true" });

  it("rejects PAT exchange when disabled (default)", async () => {
    const result = await handleExchangeTokenWithPAT(patEnvDisabled, "Bearer github_pat_test123", {
      owner: "test-org",
      repo: "test-repo",
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe("PAT exchange is disabled");
    }
  });

  // Token prefix validation: only github_pat_ and ghp_ are allowed.
  // Other prefixes (ghs_, gho_, etc.) must be rejected.
  it.each([
    { prefix: "github_pat_", accepted: true },
    { prefix: "ghp_", accepted: true },
    { prefix: "ghs_", accepted: false },
    { prefix: "gho_", accepted: false },
    { prefix: "random_", accepted: false },
  ])("prefix $prefix → accepted=$accepted", async ({ prefix, accepted }) => {
    const result = await handleExchangeTokenWithPAT(
      patEnvEnabled,
      `Bearer ${prefix}test_token_value`,
      { owner: "test-org", repo: "test-repo" },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      if (accepted) {
        // Passed format check, failed on the GitHub API call
        expect(result.error.message).not.toContain("expected a GitHub PAT");
      } else {
        expect(result.error.message).toContain("expected a GitHub PAT");
      }
    }
  });

  // Body validation in handleExchangeTokenWithPAT is reachable without network calls
  // because it happens after format checks but before the GitHub API call.
  it("rejects requests missing owner in body", async () => {
    const result = await handleExchangeTokenWithPAT(patEnvEnabled, "Bearer github_pat_test123", {
      repo: "test-repo",
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("Missing owner or repo");
    }
  });

  it("rejects requests missing repo in body", async () => {
    const result = await handleExchangeTokenWithPAT(patEnvEnabled, "Bearer github_pat_test123", {
      owner: "test-org",
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("Missing owner or repo");
    }
  });
});

// ---------------------------------------------------------------------------
// Logging Security (table-driven)
// ---------------------------------------------------------------------------

describe("Logging Security", () => {
  it.each([
    {
      label: "redacts token in HTTPS URL",
      input: "https://x-access-token:ghp_secret123@github.com/owner/repo.git",
      expected: "https://x-access-token:[REDACTED]@github.com/owner/repo.git",
      mustNotContain: ["ghp_secret123"],
    },
    {
      label: "redacts token in error message with URL",
      input:
        "Failed to clone https://x-access-token:ghs_token456@github.com/org/repo.git: permission denied",
      expected:
        "Failed to clone https://x-access-token:[REDACTED]@github.com/org/repo.git: permission denied",
      mustNotContain: ["ghs_token456"],
    },
    {
      label: "redacts multiple URLs in same string",
      input: "Tried https://user:pass1@example.com and https://other:pass2@example.org",
      expected:
        "Tried https://user:[REDACTED]@example.com and https://other:[REDACTED]@example.org",
      mustNotContain: ["pass1", "pass2"],
    },
    {
      label: "preserves strings without URLs",
      input: "Normal error message without any URLs",
      expected: "Normal error message without any URLs",
      mustNotContain: null,
    },
    {
      label: "preserves URLs without credentials",
      input: "See https://github.com/owner/repo for details",
      expected: "See https://github.com/owner/repo for details",
      mustNotContain: null,
    },
  ])("$label", ({ input, expected, mustNotContain }) => {
    const sanitized = sanitizeSecrets(input);
    if (expected !== null) {
      expect(sanitized).toBe(expected);
    }
    if (mustNotContain !== null) {
      for (const secret of mustNotContain) {
        expect(sanitized).not.toContain(secret);
      }
    }
  });
});
