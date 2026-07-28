import { describe, it, expect, vi, beforeEach } from "vitest";
import { Result } from "better-result";
import type { Env } from "../src/types";
import type { GitHubActionsJWTClaims } from "../src/oidc";

const mocks = vi.hoisted(() => ({
  validateOIDCAndExtractRepo: vi.fn(),
  runSetupWorkflowJob: vi.fn(),
  runTrackWorkflowJob: vi.fn(),
  runFinalizeWorkflowJob: vi.fn(),
}));

vi.mock("../src/oidc", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/oidc")>();
  return {
    ...original,
    validateOIDCAndExtractRepo: mocks.validateOIDCAndExtractRepo,
  };
});

vi.mock("../src/github-workflow-jobs", () => ({
  runSetupWorkflowJob: mocks.runSetupWorkflowJob,
  runTrackWorkflowJob: mocks.runTrackWorkflowJob,
  runFinalizeWorkflowJob: mocks.runFinalizeWorkflowJob,
}));

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

describe("GitHub API workflow compatibility routes", () => {
  beforeEach(() => {
    mocks.validateOIDCAndExtractRepo.mockReset();
    mocks.validateOIDCAndExtractRepo.mockResolvedValue(
      Result.ok({ claims: createClaims(), owner: "test-org", repo: "test-repo" }),
    );
    mocks.runSetupWorkflowJob.mockReset();
    mocks.runTrackWorkflowJob.mockReset();
    mocks.runFinalizeWorkflowJob.mockReset();
  });

  it("runs setup after OIDC validation", async () => {
    mocks.runSetupWorkflowJob.mockResolvedValue({ status: 200, body: { exists: true } });
    const { default: app } = await import("../src/app");
    const env = createEnv();

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
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ exists: true });
    expect(mocks.runSetupWorkflowJob).toHaveBeenCalledWith(env, {
      owner: "test-org",
      repo: "test-repo",
      issue_number: 12,
      default_branch: "main",
    });
  });

  it("adds OIDC actor context before tracking", async () => {
    mocks.runTrackWorkflowJob.mockResolvedValue({ status: 200, body: { ok: true } });
    const { default: app } = await import("../src/app");
    const env = createEnv();

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
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.runTrackWorkflowJob).toHaveBeenCalledWith(env, {
      owner: "test-org",
      repo: "test-repo",
      run_id: 42,
      run_url: "https://github.com/test-org/test-repo/actions/runs/42",
      issue_number: 12,
      created_at: "2026-06-22T00:00:00Z",
      actor: "octocat",
    });
  });

  it("preserves finalize warning responses", async () => {
    mocks.runFinalizeWorkflowJob.mockResolvedValue({
      status: 200,
      body: { ok: true, warning: "agent unavailable" },
    });
    const { default: app } = await import("../src/app");
    const env = createEnv();

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
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, warning: "agent unavailable" });
    expect(mocks.runFinalizeWorkflowJob).toHaveBeenCalledWith(env, {
      owner: "test-org",
      repo: "test-repo",
      run_id: 42,
      status: "failure",
      actor: "octocat",
    });
  });

  it("rejects repo mismatches before running the job", async () => {
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
    expect(mocks.runFinalizeWorkflowJob).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "setup field types",
      path: "/api/github/setup",
      body: {
        owner: "test-org",
        repo: "test-repo",
        issue_number: "12",
        default_branch: "main",
      },
    },
    {
      name: "track field types",
      path: "/api/github/track",
      body: {
        owner: "test-org",
        repo: "test-repo",
        run_id: "42",
        run_url: "https://github.com/test-org/test-repo/actions/runs/42",
        issue_number: 12,
        created_at: "2026-06-22T00:00:00Z",
      },
    },
  ])("rejects invalid $name before running a job", async ({ path, body }) => {
    const { default: app } = await import("../src/app");

    const response = await app.fetch(
      new Request(`https://example.com${path}`, {
        method: "POST",
        headers: { Authorization: "Bearer oidc-token" },
        body: JSON.stringify(body),
      }),
      createEnv(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid request body" });
    expect(mocks.runSetupWorkflowJob).not.toHaveBeenCalled();
    expect(mocks.runTrackWorkflowJob).not.toHaveBeenCalled();
    expect(mocks.runFinalizeWorkflowJob).not.toHaveBeenCalled();
  });

  it("rejects invalid finalize status before running a job", async () => {
    const { default: app } = await import("../src/app");

    const response = await app.fetch(
      new Request("https://example.com/api/github/track", {
        method: "PUT",
        headers: { Authorization: "Bearer oidc-token" },
        body: JSON.stringify({
          owner: "test-org",
          repo: "test-repo",
          run_id: 42,
          status: "neutral",
        }),
      }),
      createEnv(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid request body" });
    expect(mocks.runFinalizeWorkflowJob).not.toHaveBeenCalled();
  });
});
