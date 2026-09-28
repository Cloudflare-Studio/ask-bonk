import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

const mocks = vi.hoisted(() => ({
  createComment: vi.fn(),
  updateComment: vi.fn(),
  getWorkflowRunStatus: vi.fn(),
}));

// Minimal stand-in for the agents SDK base class: RepoAgent only needs state,
// env, name, and schedule() for failure-comment decisions.
vi.mock("agents", () => ({
  Agent: class {
    env: Env;
    state: unknown;
    name = "test-org/test-repo";
    schedule = vi.fn(async () => undefined);
    constructor(_ctx: unknown, env: Env) {
      this.env = env;
    }
    setState(state: unknown) {
      this.state = state;
    }
  },
}));

vi.mock("../src/github", () => ({
  createComment: mocks.createComment,
  updateComment: mocks.updateComment,
  createReviewCommentReply: vi.fn(),
  updateReviewComment: vi.fn(),
  getWorkflowRunStatus: mocks.getWorkflowRunStatus,
}));

vi.mock("../src/oidc", () => ({
  createOctokitForRepo: vi.fn(async () => ({
    octokit: {},
    installation: { id: 123, source: "cache" },
  })),
}));

const { RepoAgent } = await import("../src/agent");

const RUN_URL = "https://github.com/test-org/test-repo/actions/runs/42";

function createAgent() {
  const agent = new RepoAgent({} as never, {} as Env);
  agent.setState({
    ...agent.initialState,
    installationId: 123,
    owner: "test-org",
    repo: "test-repo",
  });
  return agent;
}

describe("RepoAgent failure comments", () => {
  beforeEach(() => {
    mocks.createComment.mockReset();
    mocks.createComment.mockResolvedValue(1001);
    mocks.updateComment.mockReset();
    mocks.getWorkflowRunStatus.mockReset();
  });

  it("comments on failed tracked runs by default", async () => {
    const agent = createAgent();
    await agent.trackRun(42, RUN_URL, 7, undefined, "octocat");
    await agent.finalizeRun(42, "failure");

    expect(mocks.createComment).toHaveBeenCalledOnce();
    expect(mocks.createComment.mock.calls[0]?.[3]).toBe(7);
    expect(mocks.createComment.mock.calls[0]?.[4]).toContain("@octocat Bonk workflow failed.");
  });

  it("honours failure_comment: false on the action finalize path", async () => {
    const agent = createAgent();
    await agent.trackRun(42, RUN_URL, 7, undefined, "octocat", false);
    await agent.finalizeRun(42, "cancelled", 7, RUN_URL, "octocat", false);

    expect(mocks.createComment).not.toHaveBeenCalled();
    expect(agent.state.activeRuns[42]).toBeUndefined();
  });

  it("honours the tracked preference when polling finds a failed run", async () => {
    const agent = createAgent();
    await agent.trackRun(42, RUN_URL, 7, undefined, "octocat", false);
    mocks.getWorkflowRunStatus.mockResolvedValue({ status: "completed", conclusion: "cancelled" });

    await agent.checkWorkflowStatus(agent.state.activeRuns[42]!);

    expect(mocks.createComment).not.toHaveBeenCalled();
    expect(agent.state.activeRuns[42]).toBeUndefined();
  });

  it("honours the tracked preference on the workflow_run webhook path", async () => {
    const agent = createAgent();
    await agent.trackRun(42, RUN_URL, 7, undefined, "octocat", false);

    await agent.handleWorkflowRunCompleted(42, "failure", RUN_URL, 7, "octocat");

    expect(mocks.createComment).not.toHaveBeenCalled();
    expect(agent.state.activeRuns[42]).toBeUndefined();
  });

  it("still edits the waiting-for-approval comment when failure comments are disabled", async () => {
    const agent = createAgent();
    await agent.trackRun(42, RUN_URL, 7, undefined, "octocat", false);

    mocks.getWorkflowRunStatus.mockResolvedValueOnce({ status: "waiting", conclusion: null });
    await agent.checkWorkflowStatus(agent.state.activeRuns[42]!);
    expect(mocks.createComment).toHaveBeenCalledOnce();

    mocks.getWorkflowRunStatus.mockResolvedValueOnce({
      status: "completed",
      conclusion: "action_required",
    });
    await agent.checkWorkflowStatus(agent.state.activeRuns[42]!);

    expect(mocks.createComment).toHaveBeenCalledOnce();
    expect(mocks.updateComment).toHaveBeenCalledOnce();
    expect(mocks.updateComment.mock.calls[0]?.[3]).toBe(1001);
    expect(mocks.updateComment.mock.calls[0]?.[4]).toContain("not approved by a maintainer");
  });

  it("still edits an earlier failure comment when failure comments are disabled", async () => {
    const agent = createAgent();
    await agent.trackRun(41, RUN_URL, 7, undefined, "octocat");
    await agent.finalizeRun(41, "failure");
    expect(mocks.createComment).toHaveBeenCalledOnce();

    await agent.trackRun(42, RUN_URL, 7, undefined, "octocat", false);
    await agent.finalizeRun(42, "cancelled", 7, RUN_URL, "octocat", false);

    expect(mocks.createComment).toHaveBeenCalledOnce();
    expect(mocks.updateComment).toHaveBeenCalledOnce();
    expect(mocks.updateComment.mock.calls[0]?.[3]).toBe(1001);
    expect(mocks.updateComment.mock.calls[0]?.[4]).toContain("Bonk workflow was cancelled.");
  });

  it("honours failure_comment: false for untracked finalize requests", async () => {
    const agent = createAgent();

    await agent.finalizeRun(42, "failure", 7, RUN_URL, "octocat", false);

    expect(mocks.createComment).not.toHaveBeenCalled();
  });
});
