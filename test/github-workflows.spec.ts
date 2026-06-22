import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { internalWorkflowHeaders, internalWorkflowRoute } from "../src/internal-workflows";
import { runFinalizeWorkflowJob } from "../src/github-workflow-jobs";
import type { Env } from "../src/types";

const mocks = vi.hoisted(() => ({
  getAgentByName: vi.fn(),
}));

vi.mock("agents", () => ({
  getAgentByName: mocks.getAgentByName,
}));

function createWorkflowEnv(): Env {
  return {
    APP_INSTALLATIONS: {
      get: async () => "123",
    },
    REPO_AGENT: {} as Env["REPO_AGENT"],
  } as Env;
}

describe("GitHub Flue workflow jobs", () => {
  beforeEach(() => {
    mocks.getAgentByName.mockReset();
  });

  it("finalizes tracked runs through RepoAgent", async () => {
    const agent = {
      setInstallationId: vi.fn(),
      finalizeRun: vi.fn(),
    };
    mocks.getAgentByName.mockResolvedValue(agent);
    const env = createWorkflowEnv();

    const result = await runFinalizeWorkflowJob(env, {
      owner: "test-org",
      repo: "test-repo",
      run_id: 42,
      status: "success",
      issue_number: 7,
      run_url: "https://github.com/test-org/test-repo/actions/runs/42",
      actor: "octocat",
    });

    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(mocks.getAgentByName).toHaveBeenCalledWith(env.REPO_AGENT, "test-org/test-repo");
    expect(agent.setInstallationId).toHaveBeenCalledWith(123, "cache");
    expect(agent.finalizeRun).toHaveBeenCalledWith(
      42,
      "success",
      7,
      "https://github.com/test-org/test-repo/actions/runs/42",
      "octocat",
    );
  });

  it("keeps finalize best-effort when RepoAgent finalization fails", async () => {
    const agent = {
      setInstallationId: vi.fn(),
      finalizeRun: vi.fn(async () => {
        throw new Error("agent unavailable");
      }),
    };
    mocks.getAgentByName.mockResolvedValue(agent);

    const result = await runFinalizeWorkflowJob(createWorkflowEnv(), {
      owner: "test-org",
      repo: "test-repo",
      run_id: 42,
      status: "failure",
      actor: "octocat",
    });

    expect(result).toEqual({ status: 200, body: { ok: true, warning: "agent unavailable" } });
  });
});

describe("Internal workflow route guard", () => {
  it("rejects direct workflow calls without the internal header", async () => {
    const guardApp = new Hono<{ Bindings: Env }>();
    guardApp.use("/workflows/github-finalize", internalWorkflowRoute);
    guardApp.post("/workflows/github-finalize", (c) => c.json({ ok: true }));

    const response = await guardApp.fetch(
      new Request("https://example.com/workflows/github-finalize", { method: "POST" }),
      createWorkflowEnv(),
    );

    expect(response.status).toBe(404);
  });

  it("admits in-process workflow calls with the internal header", async () => {
    const guardApp = new Hono<{ Bindings: Env }>();
    guardApp.use("/workflows/github-finalize", internalWorkflowRoute);
    guardApp.post("/workflows/github-finalize", (c) => c.json({ ok: true }));

    const response = await guardApp.fetch(
      new Request("https://example.com/workflows/github-finalize", {
        method: "POST",
        headers: internalWorkflowHeaders(),
      }),
      createWorkflowEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
