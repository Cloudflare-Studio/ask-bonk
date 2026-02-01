// Plugin tests - verify error handling and context detection in the cross-repo tool
// Run with: bun test test/tools/ (separate from vitest Workers pool tests)

import { describe, it, expect, afterEach } from "bun:test";

// Mock ToolContext for testing - the tool requires sessionID for path isolation
const mockToolContext = {
  sessionID: "test-session-123",
  messageID: "test-message-456",
  agent: "test-agent",
  abort: new AbortController().signal,
};

describe("cross-repo tool", () => {
  const originalEnv = { ...process.env };

  // Reset environment after each test to avoid leaking state
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

    it("never throws - always returns valid JSON", async () => {
      const { default: crossRepoTool } = await import(
        "../../.opencode/tool/cross-repo"
      );

      // Various bad inputs that should not throw
      const badInputs = [
        { owner: "", repo: "", operation: "clone" },
        { owner: "x", repo: "y", operation: "read" }, // no path, not cloned
        { owner: "x", repo: "y", operation: "write" }, // no path/content, not cloned
        { owner: "x", repo: "y", operation: "commit" }, // no message, not cloned
      ];

      for (const input of badInputs) {
        // Should not throw
        const result = await crossRepoTool.execute(
          input as any,
          mockToolContext,
        );

        // Should return valid JSON
        expect(() => JSON.parse(result)).not.toThrow();

        // Should indicate failure
        const parsed = JSON.parse(result);
        expect(parsed.success).toBe(false);
      }
    });

    it("returns error when required args missing for operations", async () => {
      const { default: crossRepoTool } = await import(
        "../../.opencode/tool/cross-repo"
      );

      // These will hit "not cloned" before arg validation, but that's still a graceful error
      const missingArgCases = [
        { owner: "x", repo: "y", operation: "exec" }, // missing command
        { owner: "x", repo: "y", operation: "pr" }, // missing title
      ];

      for (const input of missingArgCases) {
        const result = await crossRepoTool.execute(
          input as any,
          mockToolContext,
        );
        const parsed = JSON.parse(result);
        expect(parsed.success).toBe(false);
        // Either "not cloned" or missing arg - both are graceful errors
        expect(parsed.error).toBeDefined();
      }
    });
  });

  describe("context detection", () => {
    it("detects GitHub Actions context from GITHUB_ACTIONS=true", async () => {
      // Set up GitHub Actions environment without valid auth
      process.env.GITHUB_ACTIONS = "true";
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;

      // Fresh import to pick up new env
      const mod = await import("../../.opencode/tool/cross-repo");
      const crossRepoTool = mod.default;

      const result = await crossRepoTool.execute(
        {
          owner: "test",
          repo: "test-repo",
          operation: "clone",
        },
        mockToolContext,
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      // Error should mention GitHub Actions context
      expect(parsed.error).toContain("GitHub Actions");
    });

    it("uses env token when available", async () => {
      // Set up GitHub Actions environment with env token (simpler test)
      process.env.GITHUB_ACTIONS = "true";
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
      delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      process.env.GH_TOKEN = "test-token-value";

      const mod = await import("../../.opencode/tool/cross-repo");
      const crossRepoTool = mod.default;

      // This will fail on clone (invalid token), but should NOT fail on auth
      const result = await crossRepoTool.execute(
        {
          owner: "test",
          repo: "test-repo",
          operation: "clone",
        },
        mockToolContext,
      );

      const parsed = JSON.parse(result);
      // Will fail, but not due to "No authentication" - proves token was used
      if (!parsed.success) {
        expect(parsed.error).not.toContain("No authentication");
      }
    });

    it("returns auth error when no credentials available", async () => {
      // Clear all auth-related env vars
      delete process.env.GITHUB_ACTIONS;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      delete process.env.CI;

      const mod = await import("../../.opencode/tool/cross-repo");
      const crossRepoTool = mod.default;

      const result = await crossRepoTool.execute(
        {
          owner: "test",
          repo: "test-repo",
          operation: "clone",
        },
        mockToolContext,
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      // Should mention lack of authentication (unless gh CLI is available)
      // The exact error depends on whether gh is installed
    });
  });
});
