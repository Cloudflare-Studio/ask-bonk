// Plugin tests - verify error handling and context detection in the cross-repo tool.
// Run with: bun test test/tools/ (separate from vitest Workers pool tests)

import { describe, it, expect, afterEach } from "bun:test";

// Minimal mock satisfying the ToolContext fields the tool actually reads.
// Cast to `any` because ToolContext requires fields (directory, worktree, etc.)
// that the tool never accesses — a Proxy would be better but bun:test doesn't
// support vitest-style module mocking.
const mockToolContext = {
  sessionID: "test-session-123",
  messageID: "test-message-456",
  agent: "test-agent",
  abort: new AbortController().signal,
} as any;

describe("cross-repo tool", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("execute() error handling", () => {
    it("returns error JSON when repo not cloned (branch operation)", async () => {
      const { default: crossRepoTool } = await import(
        "../../.opencode/tool/cross-repo"
      );

      const result = await crossRepoTool.execute(
        {
          owner: "test",
          repo: "not-cloned-repo",
          operation: "branch",
          branch: "test-branch",
        },
        mockToolContext,
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("not cloned");
    });

    it("returns error JSON for unknown operation", async () => {
      const { default: crossRepoTool } = await import(
        "../../.opencode/tool/cross-repo"
      );

      const result = await crossRepoTool.execute(
        {
          owner: "test",
          repo: "test-repo",
          operation: "invalid-op" as any,
        },
        mockToolContext,
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Unknown operation");
    });

    // Table-driven: various bad inputs must never throw — always return valid error JSON
    it.each([
      { label: "empty owner/repo clone", owner: "", repo: "", operation: "clone" },
      { label: "read without clone", owner: "x", repo: "y", operation: "read" },
      { label: "write without clone", owner: "x", repo: "y", operation: "write" },
      { label: "commit without clone", owner: "x", repo: "y", operation: "commit" },
      { label: "exec without clone", owner: "x", repo: "y", operation: "exec" },
      { label: "pr without clone", owner: "x", repo: "y", operation: "pr" },
    ])("never throws: $label", async ({ owner, repo, operation }) => {
      const { default: crossRepoTool } = await import(
        "../../.opencode/tool/cross-repo"
      );

      const result = await crossRepoTool.execute(
        { owner, repo, operation } as any,
        mockToolContext,
      );

      // Must be parseable JSON
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(typeof parsed.error).toBe("string");
    });
  });

  describe("context detection", () => {
    it("detects GitHub Actions context from GITHUB_ACTIONS=true", async () => {
      process.env.GITHUB_ACTIONS = "true";
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;

      const mod = await import("../../.opencode/tool/cross-repo");
      const crossRepoTool = mod.default;

      const result = await crossRepoTool.execute(
        { owner: "test", repo: "test-repo", operation: "clone" },
        mockToolContext,
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("GitHub Actions");
    });

    it("uses env token when available (no auth error)", async () => {
      process.env.GITHUB_ACTIONS = "true";
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      process.env.GH_TOKEN = "test-token-value";

      const mod = await import("../../.opencode/tool/cross-repo");
      const crossRepoTool = mod.default;

      const result = await crossRepoTool.execute(
        { owner: "test", repo: "test-repo", operation: "clone" },
        mockToolContext,
      );

      const parsed = JSON.parse(result);
      // Will fail (invalid token), but NOT on "No authentication" — proves token was picked up
      if (!parsed.success) {
        expect(parsed.error).not.toContain("No authentication");
      }
    });
  });
});
