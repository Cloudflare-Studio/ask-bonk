import { describe, it, expect, vi, beforeEach } from "vitest";
import { Result } from "better-result";
import app from "../src/app";
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
    mocks.runSetupWorkflowJob.mockReset();
    mocks.runTrackWorkflowJob.mockReset();
    mocks.runFinalizeWorkflowJob.mockReset();
    mocks.validateOIDCAndExtractRepo.mockResolvedValue(
      Result.ok({ claims: createClaims(), owner: "test-org", repo: "test-repo" }),
    );
  });

  it("runs setup directly after validating OIDC claims", async () => {
    mocks.runSetupWorkflowJob.mockResolvedValue({
      status: 200,
      body: { exists: true },
    });
    const env = createEnv();
    const body = {
      owner: "test-org",
      repo: "test-repo",
      issue_number: 12,
      default_branch: "main",
    };

    const response = await app.fetch(
      new Request("https://example.com/api/github/setup", {
        method: "POST",
        headers: { Authorization: "Bearer oidc-token" },
        body: JSON.stringify(body),
      }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ exists: true });
    expect(mocks.runSetupWorkflowJob).toHaveBeenCalledWith(env, body);
  });

  it("adds OIDC actor context before tracking directly", async () => {
    mocks.runTrackWorkflowJob.mockResolvedValue({
      status: 200,
      body: { ok: true },
    });
    const env = createEnv();
    const body = {
      owner: "test-org",
      repo: "test-repo",
      run_id: 42,
      run_url: "https://github.com/test-org/test-repo/actions/runs/42",
      issue_number: 12,
      created_at: "2026-06-22T00:00:00Z",
    };

    const response = await app.fetch(
      new Request("https://example.com/api/github/track", {
        method: "POST",
        headers: { Authorization: "Bearer oidc-token" },
        body: JSON.stringify(body),
      }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.runTrackWorkflowJob).toHaveBeenCalledWith(env, {
      ...body,
      actor: "octocat",
    });
  });

  it("preserves finalize warning responses from the direct job", async () => {
    mocks.runFinalizeWorkflowJob.mockResolvedValue({
      status: 200,
      body: { ok: true, warning: "agent unavailable" },
    });
    const env = createEnv();
    const body = {
      owner: "test-org",
      repo: "test-repo",
      run_id: 42,
      status: "failure" as const,
    };

    const response = await app.fetch(
      new Request("https://example.com/api/github/track", {
        method: "PUT",
        headers: { Authorization: "Bearer oidc-token" },
        body: JSON.stringify(body),
      }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, warning: "agent unavailable" });
    expect(mocks.runFinalizeWorkflowJob).toHaveBeenCalledWith(env, {
      ...body,
      actor: "octocat",
    });
  });

  it("preserves direct job error status codes and bodies", async () => {
    mocks.runSetupWorkflowJob.mockResolvedValue({
      status: 404,
      body: { error: "installation not found" },
    });
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

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "installation not found" });
  });

  it("rejects invalid setup field types before running a job", async () => {
    const response = await app.fetch(
      new Request("https://example.com/api/github/setup", {
        method: "POST",
        headers: { Authorization: "Bearer oidc-token" },
        body: JSON.stringify({
          owner: "test-org",
          repo: "test-repo",
          issue_number: "12",
          default_branch: "main",
        }),
      }),
      createEnv(),
    );

    expect(response.status).toBe(400);
    expect(mocks.runSetupWorkflowJob).not.toHaveBeenCalled();
  });

  it("rejects invalid optional tracking fields before running a job", async () => {
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
          comment_id: "123",
        }),
      }),
      createEnv(),
    );

    expect(response.status).toBe(400);
    expect(mocks.runTrackWorkflowJob).not.toHaveBeenCalled();
  });

  it("rejects invalid finalization statuses before running a job", async () => {
    const response = await app.fetch(
      new Request("https://example.com/api/github/track", {
        method: "PUT",
        headers: { Authorization: "Bearer oidc-token" },
        body: JSON.stringify({
          owner: "test-org",
          repo: "test-repo",
          run_id: 42,
          status: "pending",
        }),
      }),
      createEnv(),
    );

    expect(response.status).toBe(400);
    expect(mocks.runFinalizeWorkflowJob).not.toHaveBeenCalled();
  });

  it("rejects repo mismatches before running a job", async () => {
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
    expect(mocks.runSetupWorkflowJob).not.toHaveBeenCalled();
    expect(mocks.runTrackWorkflowJob).not.toHaveBeenCalled();
    expect(mocks.runFinalizeWorkflowJob).not.toHaveBeenCalled();
  });
});
