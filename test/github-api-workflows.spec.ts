import { describe, it, expect, vi, beforeEach } from "vitest";
import { Result } from "better-result";
import { defineAgent, defineWorkflow } from "@flue/runtime";
import { configureFlueRuntime, type FlueRuntime } from "@flue/runtime/internal";
import { internalWorkflowRoute } from "../src/internal-workflows";
import type { Env } from "../src/types";
import type { GitHubActionsJWTClaims } from "../src/oidc";

const mocks = vi.hoisted(() => ({
  validateOIDCAndExtractRepo: vi.fn(),
}));

vi.mock("../src/oidc", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/oidc")>();
  return {
    ...original,
    validateOIDCAndExtractRepo: mocks.validateOIDCAndExtractRepo,
  };
});

function createEnv(): Env {
  return {
    GITHUB_WEBHOOK_SECRET: "test-secret",
    DEFAULT_MODEL: "anthropic/claude-opus-4-5",
    BONK_VERSION: "dev",
    BONK_COMMIT: "unknown",
    ALLOWED_ORGS: [],
  } as Env;
}

function createClaims(owner = "test-org", repo = "test-repo"): GitHubActionsJWTClaims {
  return {
    iss: "https://token.actions.githubusercontent.com",
    sub: `repo:${owner}/${repo}:ref:refs/heads/main`,
    aud: "opencode-github-action",
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    repository: `${owner}/${repo}`,
    repository_owner: owner,
    repository_id: "123456",
    repository_owner_id: "789",
    run_id: "42",
    run_number: "1",
    run_attempt: "1",
    actor: "octocat",
    actor_id: "789",
    workflow: "Bonk",
    event_name: "issue_comment",
    ref: "refs/heads/main",
    ref_type: "branch",
    job_workflow_ref: `${owner}/${repo}/.github/workflows/bonk.yml@refs/heads/main`,
    runner_environment: "github-hosted",
  };
}

function configureWorkflowForwarder(routeWorkflowRequest: FlueRuntime["routeWorkflowRequest"]) {
  const workflow = defineWorkflow({
    agent: defineAgent(() => ({ model: "anthropic/claude-haiku-4-5" })),
    run() {
      return undefined;
    },
  });
  const runtime: FlueRuntime = {
    target: "cloudflare",
    agents: [],
    workflows: [
      { name: "github-setup", definition: workflow, route: internalWorkflowRoute },
      { name: "github-track", definition: workflow, route: internalWorkflowRoute },
      { name: "github-finalize", definition: workflow, route: internalWorkflowRoute },
    ],
    dispatchQueue: {
      async enqueue(input) {
        return { dispatchId: input.dispatchId, acceptedAt: input.acceptedAt };
      },
    },
    async admitWorkflow() {
      return { runId: "test-run" };
    },
    async routeAgentRequest() {
      return null;
    },
    routeWorkflowRequest,
    async routeRunRequest() {
      return null;
    },
    createRunIndexForRequest() {
      return undefined;
    },
  };
  configureFlueRuntime(runtime);
}

describe("GitHub API workflow compatibility routes", () => {
  beforeEach(() => {
    mocks.validateOIDCAndExtractRepo.mockReset();
    mocks.validateOIDCAndExtractRepo.mockResolvedValue(
      Result.ok({ claims: createClaims(), owner: "test-org", repo: "test-repo" }),
    );
  });

  it("runs setup through the internal Flue workflow route", async () => {
    const forwarded = vi.fn(async (request: Request, _env: unknown, target) => {
      expect(target.workflowName).toBe("github-setup");
      expect(new URL(request.url).searchParams.get("wait")).toBe("result");
      await expect(request.json()).resolves.toEqual({
        owner: "test-org",
        repo: "test-repo",
        issue_number: 12,
        default_branch: "main",
      });
      return Response.json({ result: { status: 200, body: { exists: true } } });
    }) satisfies NonNullable<FlueRuntime["routeWorkflowRequest"]>;
    configureWorkflowForwarder(forwarded);
    const { default: app } = await import("../src/app");

    const response = await app.fetch(
      new Request("https://example.com/api/github/setup", {
        method: "POST",
        headers: { Authorization: "Bearer oidc-token" },
        body: JSON.stringify({
          owner: "test-org",
          repo: "test-repo",
          issue_number: 12,
          default_branch: "main",
        }),
      }),
      createEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ exists: true });
    expect(forwarded).toHaveBeenCalledOnce();
  });

  it("adds OIDC actor context before tracking through the Flue workflow", async () => {
    const forwarded = vi.fn(async (request: Request, _env: unknown, target) => {
      expect(target.workflowName).toBe("github-track");
      await expect(request.json()).resolves.toEqual({
        owner: "test-org",
        repo: "test-repo",
        run_id: 42,
        run_url: "https://github.com/test-org/test-repo/actions/runs/42",
        issue_number: 12,
        created_at: "2026-06-22T00:00:00Z",
        actor: "octocat",
      });
      return Response.json({ result: { status: 200, body: { ok: true } } });
    }) satisfies NonNullable<FlueRuntime["routeWorkflowRequest"]>;
    configureWorkflowForwarder(forwarded);
    const { default: app } = await import("../src/app");

    const response = await app.fetch(
      new Request("https://example.com/api/github/track", {
        method: "POST",
        headers: { Authorization: "Bearer oidc-token" },
        body: JSON.stringify({
          owner: "test-org",
          repo: "test-repo",
          run_id: 42,
          run_url: "https://github.com/test-org/test-repo/actions/runs/42",
          issue_number: 12,
          created_at: "2026-06-22T00:00:00Z",
        }),
      }),
      createEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(forwarded).toHaveBeenCalledOnce();
  });

  it("preserves finalize warning responses from the Flue workflow", async () => {
    const forwarded = vi.fn(async (request: Request, _env: unknown, target) => {
      expect(target.workflowName).toBe("github-finalize");
      await expect(request.json()).resolves.toEqual({
        owner: "test-org",
        repo: "test-repo",
        run_id: 42,
        status: "failure",
        actor: "octocat",
      });
      return Response.json({
        result: { status: 200, body: { ok: true, warning: "agent unavailable" } },
      });
    }) satisfies NonNullable<FlueRuntime["routeWorkflowRequest"]>;
    configureWorkflowForwarder(forwarded);
    const { default: app } = await import("../src/app");

    const response = await app.fetch(
      new Request("https://example.com/api/github/track", {
        method: "PUT",
        headers: { Authorization: "Bearer oidc-token" },
        body: JSON.stringify({
          owner: "test-org",
          repo: "test-repo",
          run_id: 42,
          status: "failure",
        }),
      }),
      createEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, warning: "agent unavailable" });
    expect(forwarded).toHaveBeenCalledOnce();
  });

  it("rejects repo mismatches before admitting a Flue workflow", async () => {
    const forwarded = vi.fn(async () => Response.json({ result: { status: 200, body: { ok: true } } }));
    configureWorkflowForwarder(forwarded);
    const { default: app } = await import("../src/app");

    const response = await app.fetch(
      new Request("https://example.com/api/github/track", {
        method: "PUT",
        headers: { Authorization: "Bearer oidc-token" },
        body: JSON.stringify({
          owner: "other-org",
          repo: "test-repo",
          run_id: 42,
          status: "failure",
        }),
      }),
      createEnv(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "OIDC token is for test-org/test-repo, not other-org/test-repo",
    });
    expect(forwarded).not.toHaveBeenCalled();
  });
});
