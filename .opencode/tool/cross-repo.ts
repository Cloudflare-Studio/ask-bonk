import { tool, type ToolContext } from "@opencode-ai/plugin";
import { Shescape } from "shescape";
import { tmpdir } from "os";
import { resolve } from "path";
import { realpathSync } from "fs";

// Shescape instance for safe shell argument escaping
// Uses bash shell explicitly since we spawn with bash -c
const shescape = new Shescape({ shell: "bash" });

// Wrapper for shescape.quote() - escapes a string for safe use as a shell argument
function shellEscape(str: string): string {
  return shescape.quote(str);
}

// Validates GitHub owner/repo identifiers to prevent path traversal via malicious names.
// GitHub allows: alphanumeric, hyphens, underscores, and dots (with restrictions).
// We're slightly more permissive but block path separators and traversal sequences.
function isValidRepoIdentifier(value: string): boolean {
  if (!value || value.length > 100) return false;
  // Block path traversal sequences and path separators
  if (value.includes("..") || value.includes("/") || value.includes("\\"))
    return false;
  // Allow typical GitHub identifier characters
  return /^[a-zA-Z0-9._-]+$/.test(value);
}

// Safely resolves a path within a base directory, preventing traversal attacks.
// Returns null if the resolved path would escape the base directory.
//
// Security notes:
// - For existing paths: returns realPath to prevent TOCTOU races
// - For non-existent paths: returns fullPath after validating all existing parents
//   (inherent TOCTOU window exists for new file writes — mitigated by parent validation)
// - Fails closed on unexpected errors (only ENOENT is treated as "path doesn't exist")
function safeResolvePath(
  basePath: string,
  relativePath: string,
): string | null {
  const normalizedBase = resolve(basePath);
  const fullPath = resolve(normalizedBase, relativePath);

  // Check the string path first (handles .. sequences)
  if (
    !fullPath.startsWith(normalizedBase + "/") &&
    fullPath !== normalizedBase
  ) {
    return null;
  }

  // Resolve base directory once — it must exist and be accessible
  let realBase: string;
  try {
    realBase = realpathSync(normalizedBase);
  } catch {
    return null; // Base directory inaccessible
  }

  // For existing paths, resolve symlinks and return the real path
  try {
    const realPath = realpathSync(fullPath);
    if (!realPath.startsWith(realBase + "/") && realPath !== realBase) {
      return null;
    }
    return realPath;
  } catch (err: unknown) {
    // Only treat ENOENT as "path doesn't exist" - fail closed on other errors
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return null;
    }

    // Path doesn't exist — check parent directories for escaping symlinks
    let checkPath = resolve(fullPath, "..");
    while (
      checkPath !== normalizedBase &&
      checkPath.startsWith(normalizedBase)
    ) {
      try {
        const realParent = realpathSync(checkPath);
        if (!realParent.startsWith(realBase + "/") && realParent !== realBase) {
          return null;
        }
        break; // Found a safe existing parent
      } catch (parentErr: unknown) {
        const parentCode = (parentErr as NodeJS.ErrnoException).code;
        if (parentCode !== "ENOENT") {
          return null;
        }
        checkPath = resolve(checkPath, "..");
      }
    }
    return fullPath; // Parents are safe, allow write to new path
  }
}

// State tracking for cloned repos across tool invocations
// Key format: "{sessionID}/{owner}/{repo}" to isolate repos per session
const clonedRepos = new Map<
  string,
  { path: string; token: string; defaultBranch: string }
>();

// Get session-scoped clone path: {tmpdir}/{sessionId}/{owner}-{repo}
// This ensures concurrent agents/sub-agents don't clobber each other
function getClonePath(sessionID: string, owner: string, repo: string): string {
  return `${tmpdir()}/${sessionID}/${owner}-${repo}`;
}

// Get the repo key for the clonedRepos map - includes sessionID for isolation
function getRepoKey(sessionID: string, owner: string, repo: string): string {
  return `${sessionID}/${owner}/${repo}`;
}

export default tool({
  description: `Operate on GitHub repositories other than the current working repository.

Use this tool when you need to:
- Clone and make changes to a different repository (e.g. "also update the docs repo")
- Create coordinated changes across multiple repos (e.g. "update the SDK and the examples repo")
- Open PRs in related repositories based on changes in the current repo
- Summarize changes from the current repo and apply related changes to another repo

The tool handles authentication automatically based on execution context:

**GitHub Actions**: Uses OIDC token exchange (requires id-token: write permission), falls back to GITHUB_TOKEN env var.
**Interactive** (terminal): Uses gh CLI (supports OAuth flow), falls back to GH_TOKEN/GITHUB_TOKEN env var.
**Non-interactive** (CI, sandbox, scripts): Uses gh CLI if authenticated, falls back to GH_TOKEN/GITHUB_TOKEN env var.

Supported operations:
- clone: Shallow clone a repo to {tmpdir}/{sessionID}/{owner}-{repo}. Returns the local path. Session-scoped paths prevent concurrent agents from clobbering each other.
- read: Read a file from the cloned repo (path relative to repo root).
- write: Write content to a file in the cloned repo (path relative to repo root).
- list: List files in the cloned repo (optionally under a subpath).
- branch: Create and checkout a new branch from the default branch.
- commit: Stage all changes and commit with a message.
- push: Push the current branch to remote.
- pr: Create a pull request using gh CLI. IMPORTANT: Always include a meaningful PR body/description via the 'message' parameter.
- exec: Run arbitrary shell commands in the cloned repo directory.

Typical workflow:
1. clone the target repo
2. Use read/write/list operations to view and modify files
3. branch to create a feature branch
4. commit your changes
5. push the branch
6. pr to create a pull request with a descriptive body (use message parameter with markdown formatting)

Prerequisites (GitHub Actions mode):
- The Bonk GitHub App must be installed on the target repository
- The workflow must have 'id-token: write' permission
- The target repo must be in the same org as the source repo
- The actor must have write access to the target repository

Prerequisites (local/CI/other environments):
- Authenticated via 'gh auth login' with appropriate permissions, or
- GH_TOKEN/GITHUB_TOKEN env var set with appropriate permissions

Security: In GitHub Actions, the token is scoped to only the target repository with minimal permissions (contents:write, pull_requests:write, issues:write).`,

  args: {
    owner: tool.schema.string().describe("Repository owner (org or user)"),
    repo: tool.schema.string().describe("Repository name"),
    operation: tool.schema
      .enum([
        "clone",
        "branch",
        "commit",
        "push",
        "pr",
        "exec",
        "read",
        "write",
        "list",
      ])
      .describe("Operation to perform on the target repository"),

    // Operation-specific args
    branch: tool.schema
      .string()
      .optional()
      .describe(
        "Branch name for 'branch' operation, or specific branch to clone for 'clone'",
      ),
    message: tool.schema
      .string()
      .optional()
      .describe(
        "Commit message for 'commit' operation. For 'pr' operation, this is the PR body/description - include a meaningful summary of changes (use markdown with ## Summary header).",
      ),
    title: tool.schema
      .string()
      .optional()
      .describe("PR title for 'pr' operation"),
    base: tool.schema
      .string()
      .optional()
      .describe("Base branch for PR (defaults to repo's default branch)"),
    command: tool.schema
      .string()
      .optional()
      .describe("Shell command to execute for 'exec' operation"),
    path: tool.schema
      .string()
      .optional()
      .describe(
        "File path for 'read', 'write', or 'list' operations (relative to repo root)",
      ),
    content: tool.schema
      .string()
      .optional()
      .describe("File content for 'write' operation"),
  },

  async execute(args, ctx: ToolContext) {
    const repoKey = getRepoKey(ctx.sessionID, args.owner, args.repo);

    // Helper to stringify result - OpenCode's tool validation requires output to be a string
    const stringify = (result: object) => JSON.stringify(result);

    try {
      switch (args.operation) {
        case "clone":
          return stringify(
            await cloneRepo(ctx.sessionID, args.owner, args.repo, args.branch),
          );

        case "branch": {
          const state = clonedRepos.get(repoKey);
          if (!state) {
            return stringify({
              success: false,
              error: `Repository ${repoKey} not cloned. Run clone operation first.`,
            });
          }
          if (!args.branch) {
            return stringify({
              success: false,
              error: "Branch name required for 'branch' operation",
            });
          }
          return stringify(await createBranch(state.path, args.branch));
        }

        case "commit": {
          const state = clonedRepos.get(repoKey);
          if (!state) {
            return stringify({
              success: false,
              error: `Repository ${repoKey} not cloned. Run clone operation first.`,
            });
          }
          if (!args.message) {
            return stringify({
              success: false,
              error: "Commit message required for 'commit' operation",
            });
          }
          return stringify(await commitChanges(state.path, args.message));
        }

        case "push": {
          const state = clonedRepos.get(repoKey);
          if (!state) {
            return stringify({
              success: false,
              error: `Repository ${repoKey} not cloned. Run clone operation first.`,
            });
          }
          return stringify(await pushBranch(state.path, state.token));
        }

        case "pr": {
          const state = clonedRepos.get(repoKey);
          if (!state) {
            return stringify({
              success: false,
              error: `Repository ${repoKey} not cloned. Run clone operation first.`,
            });
          }
          if (!args.title) {
            return stringify({
              success: false,
              error: "PR title required for 'pr' operation",
            });
          }
          return stringify(
            await createPR(
              state.path,
              state.token,
              args.title,
              args.message,
              args.base || state.defaultBranch,
            ),
          );
        }

        case "exec": {
          const state = clonedRepos.get(repoKey);
          if (!state) {
            return stringify({
              success: false,
              error: `Repository ${repoKey} not cloned. Run clone operation first.`,
            });
          }
          if (!args.command) {
            return stringify({
              success: false,
              error: "Command required for 'exec' operation",
            });
          }
          return stringify(await execCommand(state.path, args.command));
        }

        case "read": {
          const state = clonedRepos.get(repoKey);
          if (!state) {
            return stringify({
              success: false,
              error: `Repository ${repoKey} not cloned. Run clone operation first.`,
            });
          }
          if (!args.path) {
            return stringify({
              success: false,
              error: "Path required for 'read' operation",
            });
          }
          return stringify(await readFile(state.path, args.path));
        }

        case "write": {
          const state = clonedRepos.get(repoKey);
          if (!state) {
            return stringify({
              success: false,
              error: `Repository ${repoKey} not cloned. Run clone operation first.`,
            });
          }
          if (!args.path) {
            return stringify({
              success: false,
              error: "Path required for 'write' operation",
            });
          }
          if (args.content === undefined) {
            return stringify({
              success: false,
              error: "Content required for 'write' operation",
            });
          }
          return stringify(
            await writeFile(state.path, args.path, args.content),
          );
        }

        case "list": {
          const state = clonedRepos.get(repoKey);
          if (!state) {
            return stringify({
              success: false,
              error: `Repository ${repoKey} not cloned. Run clone operation first.`,
            });
          }
          return stringify(await listFiles(state.path, args.path));
        }

        default:
          return stringify({
            success: false,
            error: `Unknown operation: ${args.operation}`,
          });
      }
    } catch (error) {
      // Return error as a result rather than throwing - tools should be crash-resistant
      const message = error instanceof Error ? error.message : String(error);
      console.error(`cross-repo tool error [${args.operation}]:`, message);
      return stringify({
        success: false,
        error: `Unexpected error: ${message}`,
      });
    }
  },
});

// Execution context types for the cross-repo tool
// Simplified to: GitHub Actions (OIDC available), Interactive (TTY), Non-interactive (everything else)
type ExecutionContextType =
  | "github-actions"
  | "interactive"
  | "non-interactive";

interface ExecutionContext {
  type: ExecutionContextType;
  hasOIDC: boolean;
  hasGhCli: boolean | null; // null = not yet checked
  hasGitHubToken: boolean;
}

// Cache gh CLI availability to avoid repeated shell calls
let ghCliAvailable: boolean | null = null;

// Check if running in GitHub Actions per GitHub docs:
// https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/store-information-in-variables#default-environment-variables
function isGitHubActions(): boolean {
  // GITHUB_ACTIONS is always "true" when running in GitHub Actions
  return process.env.GITHUB_ACTIONS === "true";
}

// Check if OIDC permissions are available (requires id-token: write in workflow)
function hasOIDCPermissions(): boolean {
  return !!(
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL &&
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  );
}

// Check if running in an interactive terminal context
function isInteractive(): boolean {
  // If CI env var is set, always treat as non-interactive regardless of TTY
  if (process.env.CI === "true") {
    return false;
  }
  // Check if stdin/stdout are TTYs (indicates interactive terminal)
  return !!(process.stdin?.isTTY && process.stdout?.isTTY);
}

// Check if gh CLI is available and authenticated
// Result is cached to avoid repeated shell calls
async function checkGhCliAvailable(): Promise<boolean> {
  if (ghCliAvailable !== null) {
    return ghCliAvailable;
  }

  // Check both that gh exists and that it's authenticated
  const result = await run("gh auth status", 5_000);
  ghCliAvailable = result.success;
  return ghCliAvailable;
}

// Detect the current execution context
// This determines which authentication strategies are available
async function detectExecutionContext(): Promise<ExecutionContext> {
  const env = process.env;

  // GitHub Actions - use GITHUB_ACTIONS per docs
  if (isGitHubActions()) {
    return {
      type: "github-actions",
      hasOIDC: hasOIDCPermissions(),
      hasGhCli: false, // Don't use gh CLI in Actions - use OIDC or token
      hasGitHubToken: !!(env.GH_TOKEN || env.GITHUB_TOKEN),
    };
  }

  // Interactive terminal (TTY present and not in CI)
  if (isInteractive()) {
    return {
      type: "interactive",
      hasOIDC: false,
      hasGhCli: await checkGhCliAvailable(),
      hasGitHubToken: !!(env.GH_TOKEN || env.GITHUB_TOKEN),
    };
  }

  // Non-interactive: CI systems, sandboxes, piped contexts, scripts
  // All use the same auth strategy: gh CLI -> GH_TOKEN/GITHUB_TOKEN
  return {
    type: "non-interactive",
    hasOIDC: false,
    hasGhCli: await checkGhCliAvailable(),
    hasGitHubToken: !!(env.GH_TOKEN || env.GITHUB_TOKEN),
  };
}

// Try to get token from gh CLI
async function getGhCliToken(): Promise<string | null> {
  const result = await run("gh auth token", 5_000);
  return result.success ? result.stdout.trim() : null;
}

// Get token via GitHub Actions OIDC exchange
// Wrapped in try/catch for crash resistance - network errors return { error } instead of throwing
async function getTokenViaOIDC(
  owner: string,
  repo: string,
): Promise<{ token: string } | { error: string }> {
  try {
    const tokenUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const tokenRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

    // Request OIDC token with custom audience for Bonk
    const oidcUrl = `${tokenUrl}&audience=opencode-github-action`;
    const oidcResponse = await fetch(oidcUrl, {
      headers: { Authorization: `Bearer ${tokenRequestToken}` },
    });

    if (!oidcResponse.ok) {
      return { error: `Failed to get OIDC token: ${oidcResponse.statusText}` };
    }

    const { value: oidcToken } = (await oidcResponse.json()) as {
      value: string;
    };

    // Exchange OIDC token for installation token via Bonk API
    // OIDC_BASE_URL is set by the OpenCode GitHub Action from the oidc_base_url workflow input
    // It already includes the /auth path, e.g. "https://ask-bonk.silverlock.workers.dev/auth"
    const oidcBaseUrl = process.env.OIDC_BASE_URL;
    if (!oidcBaseUrl) {
      return {
        error:
          "OIDC_BASE_URL environment variable not set. Ensure the workflow passes oidc_base_url to the OpenCode action.",
      };
    }
    const exchangeResponse = await fetch(
      `${oidcBaseUrl}/exchange_github_app_token_for_repo`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${oidcToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ owner, repo }),
      },
    );

    if (!exchangeResponse.ok) {
      const errorBody = await exchangeResponse.text();
      if (exchangeResponse.status === 401) {
        return {
          error: `Authentication failed for ${owner}/${repo}. Ensure the Bonk GitHub App is installed on the target repository.`,
        };
      }
      return { error: `Failed to get installation token: ${errorBody}` };
    }

    const { token } = (await exchangeResponse.json()) as { token: string };
    return { token };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `OIDC token exchange failed: ${message}` };
  }
}

// Get token for target repo - uses context-aware auth strategy hierarchy
//
// Authentication strategies by context:
// - GitHub Actions: OIDC (preferred) -> GH_TOKEN/GITHUB_TOKEN env var
// - Interactive/Non-interactive: gh CLI -> GH_TOKEN/GITHUB_TOKEN env var
async function getTargetRepoToken(
  owner: string,
  repo: string,
): Promise<{ token: string } | { error: string }> {
  const context = await detectExecutionContext();

  // GitHub Actions: OIDC is strongly preferred for cross-repo access
  if (context.type === "github-actions") {
    if (context.hasOIDC) {
      return await getTokenViaOIDC(owner, repo);
    }
    // Fall back to env token if OIDC not available (missing id-token: write)
    if (context.hasGitHubToken) {
      const envToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
      return { token: envToken! };
    }
    return {
      error:
        "In GitHub Actions but no authentication available. Add 'id-token: write' permission for OIDC, or set GITHUB_TOKEN.",
    };
  }

  // Interactive and Non-interactive contexts: Try gh CLI first, then env token
  // gh CLI is preferred because:
  // - In interactive mode, it can trigger OAuth flow if not authenticated
  // - It respects GH_HOST and other gh config
  if (context.hasGhCli) {
    const ghToken = await getGhCliToken();
    if (ghToken) {
      return { token: ghToken };
    }
  }

  // Fall back to environment variable token
  if (context.hasGitHubToken) {
    const envToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    return { token: envToken! };
  }

  // Build context-specific error message
  const contextHints: Record<ExecutionContextType, string> = {
    "github-actions": "Add 'id-token: write' permission or set GITHUB_TOKEN.",
    interactive:
      "Run 'gh auth login' to authenticate, or set GH_TOKEN/GITHUB_TOKEN.",
    "non-interactive":
      "Set GH_TOKEN/GITHUB_TOKEN, or ensure 'gh auth login' was run.",
  };

  return {
    error: `No authentication available (context: ${context.type}). ${contextHints[context.type]}`,
  };
}

async function cloneRepo(
  sessionID: string,
  owner: string,
  repo: string,
  branch?: string,
): Promise<{
  success: boolean;
  path?: string;
  defaultBranch?: string;
  error?: string;
}> {
  // Validate owner and repo to prevent path traversal via malicious identifiers
  if (!isValidRepoIdentifier(owner)) {
    return { success: false, error: `Invalid owner name: ${owner}` };
  }
  if (!isValidRepoIdentifier(repo)) {
    return { success: false, error: `Invalid repo name: ${repo}` };
  }

  const repoKey = getRepoKey(sessionID, owner, repo);

  // Check if already cloned
  if (clonedRepos.has(repoKey)) {
    const state = clonedRepos.get(repoKey)!;
    return {
      success: true,
      path: state.path,
      defaultBranch: state.defaultBranch,
    };
  }

  // Get installation token
  const tokenResult = await getTargetRepoToken(owner, repo);
  if ("error" in tokenResult) {
    return { success: false, error: tokenResult.error };
  }

  // Session-scoped path prevents concurrent agents from clobbering each other
  const clonePath = getClonePath(sessionID, owner, repo);

  // Ensure parent directory exists
  await run(`mkdir -p ${shellEscape(`${tmpdir()}/${sessionID}`)}`);
  const cloneUrl = `https://x-access-token:${tokenResult.token}@github.com/${owner}/${repo}.git`;

  // Remove existing directory if present
  await run(`rm -rf ${shellEscape(clonePath)}`);

  // Clone with depth 1 for speed - use shellEscape for branch name to prevent injection
  const branchArg = branch ? `--branch ${shellEscape(branch)}` : "";
  const cloneResult = await run(
    `git clone --depth 1 ${branchArg} ${shellEscape(cloneUrl)} ${shellEscape(clonePath)}`,
  );

  if (!cloneResult.success) {
    return { success: false, error: `Clone failed: ${cloneResult.stderr}` };
  }

  // Get default branch
  const defaultBranchResult = await run(
    `git -C ${shellEscape(clonePath)} rev-parse --abbrev-ref HEAD`,
  );
  const defaultBranch = defaultBranchResult.stdout.trim() || "main";

  // Configure git user for commits
  await run(
    `git -C ${shellEscape(clonePath)} config user.email "bonk[bot]@users.noreply.github.com"`,
  );
  await run(`git -C ${shellEscape(clonePath)} config user.name "bonk[bot]"`);

  // Store state for subsequent operations
  clonedRepos.set(repoKey, {
    path: clonePath,
    token: tokenResult.token,
    defaultBranch,
  });

  return { success: true, path: clonePath, defaultBranch };
}

async function createBranch(
  repoPath: string,
  branchName: string,
): Promise<{ success: boolean; branch?: string; error?: string }> {
  // Create and checkout new branch with properly escaped branch name
  const result = await run(
    `git -C ${shellEscape(repoPath)} checkout -b ${shellEscape(branchName)}`,
  );

  if (!result.success) {
    // Branch might already exist, try just checking it out
    const checkoutResult = await run(
      `git -C ${shellEscape(repoPath)} checkout ${shellEscape(branchName)}`,
    );
    if (!checkoutResult.success) {
      return {
        success: false,
        error: `Failed to create/checkout branch: ${result.stderr}`,
      };
    }
  }

  return { success: true, branch: branchName };
}

async function commitChanges(
  repoPath: string,
  message: string,
): Promise<{ success: boolean; commit?: string; error?: string }> {
  // Stage all changes
  const addResult = await run(`git -C ${shellEscape(repoPath)} add -A`);
  if (!addResult.success) {
    return {
      success: false,
      error: `Failed to stage changes: ${addResult.stderr}`,
    };
  }

  // Check if there are changes to commit
  const statusResult = await run(
    `git -C ${shellEscape(repoPath)} status --porcelain`,
  );
  if (!statusResult.stdout.trim()) {
    return { success: false, error: "No changes to commit" };
  }

  // Commit with properly escaped message
  const commitResult = await run(
    `git -C ${shellEscape(repoPath)} commit -m ${shellEscape(message)}`,
  );
  if (!commitResult.success) {
    return {
      success: false,
      error: `Failed to commit: ${commitResult.stderr}`,
    };
  }

  // Get commit SHA
  const shaResult = await run(`git -C ${shellEscape(repoPath)} rev-parse HEAD`);
  const commit = shaResult.stdout.trim();

  return { success: true, commit };
}

async function pushBranch(
  repoPath: string,
  token: string,
): Promise<{ success: boolean; error?: string }> {
  // Get current branch
  const branchResult = await run(
    `git -C ${shellEscape(repoPath)} rev-parse --abbrev-ref HEAD`,
  );
  const branch = branchResult.stdout.trim();

  // Get remote URL and inject token
  const remoteResult = await run(
    `git -C ${shellEscape(repoPath)} remote get-url origin`,
  );
  let remoteUrl = remoteResult.stdout.trim();

  // Ensure token is in the URL for push
  if (!remoteUrl.includes("x-access-token")) {
    remoteUrl = remoteUrl.replace(
      "https://",
      `https://x-access-token:${token}@`,
    );
    await run(
      `git -C ${shellEscape(repoPath)} remote set-url origin ${shellEscape(remoteUrl)}`,
    );
  }

  // Push with upstream tracking
  const pushResult = await run(
    `git -C ${shellEscape(repoPath)} push -u origin ${shellEscape(branch)}`,
  );

  if (!pushResult.success) {
    return { success: false, error: `Push failed: ${pushResult.stderr}` };
  }

  return { success: true };
}

async function createPR(
  repoPath: string,
  token: string,
  title: string,
  body?: string,
  base?: string,
): Promise<{
  success: boolean;
  prUrl?: string;
  prNumber?: number;
  error?: string;
}> {
  // Get current branch
  const branchResult = await run(
    `git -C ${shellEscape(repoPath)} rev-parse --abbrev-ref HEAD`,
  );
  const headBranch = branchResult.stdout.trim();

  // Use gh CLI with token auth and properly escaped arguments
  const bodyArg = body
    ? `--body ${shellEscape(body)}`
    : `--body ${shellEscape("")}`;
  const baseArg = base ? `--base ${shellEscape(base)}` : "";

  const prResult = await run(
    `cd ${shellEscape(repoPath)} && GH_TOKEN=${shellEscape(token)} gh pr create --title ${shellEscape(title)} ${bodyArg} ${baseArg} --head ${shellEscape(headBranch)}`,
  );

  if (!prResult.success) {
    return { success: false, error: `PR creation failed: ${prResult.stderr}` };
  }

  // Parse PR URL from output
  const prUrl = prResult.stdout.trim();
  const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
  const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : undefined;

  return { success: true, prUrl, prNumber };
}

async function readFile(
  repoPath: string,
  filePath: string,
): Promise<{ success: boolean; content?: string; error?: string }> {
  // Safely resolve the path, preventing traversal attacks
  const fullPath = safeResolvePath(repoPath, filePath);
  if (!fullPath) {
    return { success: false, error: "Invalid path: path traversal detected" };
  }

  const result = await run(`cat ${shellEscape(fullPath)}`);
  if (!result.success) {
    return { success: false, error: `Failed to read file: ${result.stderr}` };
  }

  return { success: true, content: result.stdout };
}

async function writeFile(
  repoPath: string,
  filePath: string,
  content: string,
): Promise<{ success: boolean; error?: string }> {
  // Safely resolve the path, preventing traversal attacks
  const fullPath = safeResolvePath(repoPath, filePath);
  if (!fullPath) {
    return { success: false, error: "Invalid path: path traversal detected" };
  }

  // Create parent directories if needed
  const dirPath = fullPath.substring(0, fullPath.lastIndexOf("/"));
  await run(`mkdir -p ${shellEscape(dirPath)}`);

  // Write content using a heredoc to handle special characters safely
  // Use base64 encoding to safely pass arbitrary content through the shell
  const base64Content = Buffer.from(content).toString("base64");
  const result = await run(
    `echo ${shellEscape(base64Content)} | base64 -d > ${shellEscape(fullPath)}`,
  );

  if (!result.success) {
    return { success: false, error: `Failed to write file: ${result.stderr}` };
  }

  return { success: true };
}

async function listFiles(
  repoPath: string,
  subPath?: string,
): Promise<{ success: boolean; files?: string[]; error?: string }> {
  // Safely resolve the path if subPath provided, preventing traversal attacks
  const targetPath = subPath
    ? safeResolvePath(repoPath, subPath)
    : resolve(repoPath);
  if (!targetPath) {
    return { success: false, error: "Invalid path: path traversal detected" };
  }

  // List files excluding .git directory
  const result = await run(
    `find ${shellEscape(targetPath)} -type f ! -path '*/\\.git/*'`,
  );
  if (!result.success) {
    return { success: false, error: `Failed to list files: ${result.stderr}` };
  }

  // Strip the repo path prefix in JS to avoid sed pattern injection issues
  const prefix = resolve(repoPath) + "/";
  const files = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((f) => (f.startsWith(prefix) ? f.slice(prefix.length) : f));

  return { success: true, files };
}

async function execCommand(
  repoPath: string,
  command: string,
): Promise<{
  success: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}> {
  // Note: The command is intentionally NOT escaped - the exec operation is designed
  // to allow arbitrary shell commands. Security is handled at the API layer by:
  // 1. Same-org restriction on token exchange
  // 2. Actor write access verification
  // 3. Visibility restriction (public repos can't access private repos)
  // The LLM/user providing the command is already authorized to write to this repo.

  // Audit log: exec is a powerful operation - log for visibility (truncate command for safety)
  console.log(
    JSON.stringify({
      event: "cross_repo_exec",
      repo_path: repoPath,
      command_preview:
        command.slice(0, 100) + (command.length > 100 ? "..." : ""),
    }),
  );

  const result = await run(`cd ${shellEscape(repoPath)} && ${command}`);

  return {
    success: result.success,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.success ? undefined : result.stderr,
  };
}

// Simple shell execution helper with timeout and non-interactive mode
// Timeout defaults to 60 seconds - shorter than GitHub Actions to catch hangs early
async function run(
  command: string,
  timeoutMs: number = 60_000,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["bash", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
      // CRITICAL: Set stdin to "ignore" to prevent ANY prompting
      // Without this, commands can hang forever waiting for input
      stdin: "ignore",
      // Kill the process if it exceeds the timeout
      timeout: timeoutMs,
      // Non-interactive environment settings
      env: {
        ...process.env,
        // Disable git's terminal prompts - fail fast instead of waiting for input
        GIT_TERMINAL_PROMPT: "0",
        // Disable SSH interactive prompts
        GIT_SSH_COMMAND:
          "ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new",
        // Disable pagers that might wait for input
        GIT_PAGER: "cat",
        PAGER: "cat",
        // Force non-interactive mode for various tools
        DEBIAN_FRONTEND: "noninteractive",
        // Disable colors/formatting that might cause issues
        NO_COLOR: "1",
        TERM: "dumb",
      },
    });

    const exited = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    return {
      success: exited === 0,
      stdout,
      stderr,
    };
  } catch (error) {
    return {
      success: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}
