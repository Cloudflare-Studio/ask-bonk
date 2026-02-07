import { describe, it, expect } from "vitest";
import {
  extractPrompt,
  parseIssueCommentEvent,
  parsePRReviewCommentEvent,
  parsePRReviewEvent,
  parseScheduleEvent,
  parseIssuesEvent,
  parseWorkflowDispatchEvent,
  getModel,
  formatResponse,
  generateBranchName,
} from "../src/events";
import type {
  ScheduleEventPayload,
  WorkflowDispatchPayload,
} from "../src/types";
import type { IssuesEvent } from "@octokit/webhooks-types";
import { extractRepoFromClaims } from "../src/oidc";
import { sanitizeSecrets } from "../src/log";
import type { Env } from "../src/types";
import type {
  IssueCommentEvent,
  PullRequestReviewCommentEvent,
  PullRequestReviewEvent,
} from "@octokit/webhooks-types";

// Read fixtures
import issueCommentFixture from "./fixtures/issue-comment.json";
import prReviewCommentFixture from "./fixtures/pr-review-comment.json";

// Helper to create mock Env with optional overrides - avoids duplicating the full object
function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    Sandbox: {} as Env["Sandbox"],
    REPO_AGENT: {} as Env["REPO_AGENT"],
    APP_INSTALLATIONS: {
      get: async () => null,
      put: async () => {},
    } as unknown as Env["APP_INSTALLATIONS"],
    RATE_LIMITER: {} as Env["RATE_LIMITER"],
    BONK_EVENTS: {} as Env["BONK_EVENTS"],
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "test-key",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    OPENCODE_API_KEY: "test-api-key",
    DEFAULT_MODEL: "anthropic/claude-opus-4-5",
    ...overrides,
  };
}

const mockEnv = createMockEnv();

describe("Prompt Extraction", () => {
  it("extracts full prompt", () => {
    const prompt = extractPrompt("@ask-bonk fix the type error");
    expect(prompt).toBe("@ask-bonk fix the type error");
  });

  it("returns prompt as-is without special handling for bare mention", () => {
    // Note: extractPrompt no longer has special handling for bare mentions
    // The action handles mentions; this just extracts the prompt
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

describe("Issue Comment Event Parsing", () => {
  it("parses valid issue comment event", () => {
    const result = parseIssueCommentEvent(
      issueCommentFixture as unknown as IssueCommentEvent,
    );

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
    const result = parseIssueCommentEvent(
      payload as unknown as IssueCommentEvent,
    );
    expect(result).toBeNull();
  });

  it("parses comments without mention (filtering is done by action)", () => {
    // Note: mention filtering is now done by the GitHub Action, not the event parser
    const payload = {
      ...issueCommentFixture,
      comment: {
        ...issueCommentFixture.comment,
        body: "just a regular comment",
      },
    };
    const result = parseIssueCommentEvent(
      payload as unknown as IssueCommentEvent,
    );
    // Should parse - action will filter based on mentions
    expect(result).not.toBeNull();
    expect(result?.prompt).toBe("just a regular comment");
  });
});

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

  it("sets isFork true for fork PRs instead of dropping them", () => {
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
    expect(result).not.toBeNull();
    expect(result?.context.isFork).toBe(true);
    expect(result?.context.isPullRequest).toBe(true);
  });

  it("sets isFork false for same-repo PRs", () => {
    const result = parsePRReviewCommentEvent(
      prReviewCommentFixture as unknown as PullRequestReviewCommentEvent,
    );
    expect(result).not.toBeNull();
    expect(result?.context.isFork).toBe(false);
  });
});

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

  it("sets isFork true for fork PRs", () => {
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
    const result = parsePRReviewEvent(
      forkPayload as unknown as PullRequestReviewEvent,
    );
    expect(result).not.toBeNull();
    expect(result?.context.isFork).toBe(true);
  });

  it("sets isFork false for same-repo PRs", () => {
    const result = parsePRReviewEvent(
      basePRReviewPayload as unknown as PullRequestReviewEvent,
    );
    expect(result).not.toBeNull();
    expect(result?.context.isFork).toBe(false);
  });
});

describe("Model Configuration", () => {
  it("returns default model when DEFAULT_MODEL set", () => {
    const model = getModel(mockEnv);
    expect(model.providerID).toBe("anthropic");
    expect(model.modelID).toBe("claude-opus-4-5");
  });

  it("returns hardcoded default when no DEFAULT_MODEL", () => {
    const envWithoutDefault = { ...mockEnv, DEFAULT_MODEL: undefined };
    const model = getModel(envWithoutDefault);
    expect(model.providerID).toBe("opencode");
    expect(model.modelID).toBe("claude-opus-4-5");
  });
});

describe("Response Formatting", () => {
  it("formats basic response", () => {
    const response = formatResponse(
      "Here is the fix",
      null,
      null,
      "anthropic/claude-opus-4-5",
    );
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
    expect(result?.context.actor).toBe("testuser"); // uses sender.login for edited
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
    const result = parseWorkflowDispatchEvent(
      payload as WorkflowDispatchPayload,
    );
    expect(result).toBeNull();
  });
});

describe("Model Parsing Edge Cases", () => {
  it("handles model with nested slashes", () => {
    const envWithNestedModel = {
      ...mockEnv,
      DEFAULT_MODEL: "opencode/claude-3-5-sonnet-v2",
    };
    const model = getModel(envWithNestedModel);
    expect(model.providerID).toBe("opencode");
    expect(model.modelID).toBe("claude-3-5-sonnet-v2");
  });

  it("throws on invalid model format without slash", () => {
    const envWithBadModel = { ...mockEnv, DEFAULT_MODEL: "invalid-model" };
    expect(() => getModel(envWithBadModel)).toThrow("Invalid model");
  });
});

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
      job_workflow_ref:
        "octocat/hello-world/.github/workflows/ci.yml@refs/heads/main",
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

// Tests for handleExchangeTokenForRepo security controls.
// These test the handler's validation logic by calling it with mock inputs.
// The handler rejects requests early if validation fails, before any external API calls.
describe("Cross-Repo Token Exchange Input Validation", () => {
  const testEnv = createMockEnv();

  it("rejects requests without Authorization header", async () => {
    const { handleExchangeTokenForRepo } = await import("../src/oidc");
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
    const { handleExchangeTokenForRepo } = await import("../src/oidc");
    const result = await handleExchangeTokenForRepo(testEnv, "Basic abc123", {
      owner: "test-org",
      repo: "test-repo",
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("Authorization");
    }
  });

  it("rejects requests missing owner in body", async () => {
    const { handleExchangeTokenForRepo } = await import("../src/oidc");
    // Using a fake token - it will fail OIDC validation, but that's fine
    // We're testing that the handler validates body params too
    const result = await handleExchangeTokenForRepo(
      testEnv,
      "Bearer fake.jwt.token",
      {
        repo: "test-repo",
      },
    );

    // Will fail either on OIDC validation or body validation - both are acceptable
    expect(result.isErr()).toBe(true);
  });

  it("rejects requests missing repo in body", async () => {
    const { handleExchangeTokenForRepo } = await import("../src/oidc");
    const result = await handleExchangeTokenForRepo(
      testEnv,
      "Bearer fake.jwt.token",
      {
        owner: "test-org",
      },
    );

    expect(result.isErr()).toBe(true);
  });
});

describe("PAT Exchange Security", () => {
  const patEnvDisabled = createMockEnv(); // ENABLE_PAT_EXCHANGE not set - disabled by default
  const patEnvEnabled = createMockEnv({ ENABLE_PAT_EXCHANGE: "true" });

  it("rejects PAT exchange when disabled (default)", async () => {
    const { handleExchangeTokenWithPAT } = await import("../src/oidc");
    const result = await handleExchangeTokenWithPAT(
      patEnvDisabled,
      "Bearer github_pat_test123",
      {
        owner: "test-org",
        repo: "test-repo",
      },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe("PAT exchange is disabled");
    }
  });

  it("rejects non-PAT tokens even when enabled", async () => {
    const { handleExchangeTokenWithPAT } = await import("../src/oidc");
    const result = await handleExchangeTokenWithPAT(
      patEnvEnabled,
      "Bearer ghs_servicetoken123",
      {
        owner: "test-org",
        repo: "test-repo",
      },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("expected a GitHub PAT");
    }
  });

  it("accepts github_pat_ prefix when enabled", async () => {
    const { handleExchangeTokenWithPAT } = await import("../src/oidc");
    // This will fail at the GitHub API call, but should pass the PAT format check
    const result = await handleExchangeTokenWithPAT(
      patEnvEnabled,
      "Bearer github_pat_valid_format",
      {
        owner: "test-org",
        repo: "test-repo",
      },
    );

    // Should fail on API call, not on format validation
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).not.toContain("expected a GitHub PAT");
    }
  });

  it("accepts ghp_ prefix when enabled", async () => {
    const { handleExchangeTokenWithPAT } = await import("../src/oidc");
    // This will fail at the GitHub API call, but should pass the PAT format check
    const result = await handleExchangeTokenWithPAT(
      patEnvEnabled,
      "Bearer ghp_valid_format",
      {
        owner: "test-org",
        repo: "test-repo",
      },
    );

    // Should fail on API call, not on format validation
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).not.toContain("expected a GitHub PAT");
    }
  });
});

describe("Logging Security", () => {
  it("redacts tokens in HTTPS URLs", () => {
    const url =
      "https://x-access-token:ghp_secret123@github.com/owner/repo.git";
    const sanitized = sanitizeSecrets(url);
    expect(sanitized).toBe(
      "https://x-access-token:[REDACTED]@github.com/owner/repo.git",
    );
    expect(sanitized).not.toContain("ghp_secret123");
  });

  it("redacts tokens in error messages containing URLs", () => {
    const message =
      "Failed to clone https://x-access-token:ghs_token456@github.com/org/repo.git: permission denied";
    const sanitized = sanitizeSecrets(message);
    expect(sanitized).toBe(
      "Failed to clone https://x-access-token:[REDACTED]@github.com/org/repo.git: permission denied",
    );
    expect(sanitized).not.toContain("ghs_token456");
  });

  it("handles multiple URLs in the same string", () => {
    const message =
      "Tried https://user:pass1@example.com and https://other:pass2@example.org";
    const sanitized = sanitizeSecrets(message);
    expect(sanitized).not.toContain("pass1");
    expect(sanitized).not.toContain("pass2");
    expect(sanitized).toContain("[REDACTED]");
  });

  it("preserves strings without URLs", () => {
    const message = "Normal error message without any URLs";
    expect(sanitizeSecrets(message)).toBe(message);
  });

  it("preserves URLs without credentials", () => {
    const message = "See https://github.com/owner/repo for details";
    expect(sanitizeSecrets(message)).toBe(message);
  });
});
