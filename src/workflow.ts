import type { Octokit } from "@octokit/rest";
import { DEFAULT_MODEL } from "./types";
import {
  createComment,
  fileExists,
  getDefaultBranchSha,
  createBranch,
  createOrUpdateFile,
  createPullRequest,
  findOpenPR,
} from "./github";
import workflowTemplate from "../cli/templates/bonk.yml.hbs";
import { createLogger } from "./log";

const WORKFLOW_FILE_PATH = ".github/workflows/bonk.yml";
const WORKFLOW_BRANCH = "bonk/add-workflow-file";

export interface SetupResult {
  exists: boolean;
  prUrl?: string;
  prNumber?: number;
}

const BOT_MENTION = "@ask-bonk";
const BOT_COMMAND = "/bonk";

function generateWorkflowContent(): string {
  return workflowTemplate
    .replace(/\{\{BOT_MENTION\}\}/g, BOT_MENTION)
    .replace(/\{\{BOT_COMMAND\}\}/g, BOT_COMMAND)
    .replace(/\{\{MODEL\}\}/g, DEFAULT_MODEL);
}

// Check if workflow file exists, create PR if not
export async function ensureWorkflowFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  defaultBranch: string,
): Promise<SetupResult> {
  const workflowLog = createLogger({ owner, repo, issue_number: issueNumber });
  const hasWorkflow = await fileExists(octokit, owner, repo, WORKFLOW_FILE_PATH);

  if (hasWorkflow) {
    workflowLog.info("workflow_file_exists");
    return { exists: true };
  }

  workflowLog.info("workflow_file_missing_creating_pr");
  return await createWorkflowPR(octokit, owner, repo, issueNumber, defaultBranch);
}

async function createWorkflowPR(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  defaultBranch: string,
): Promise<SetupResult> {
  const existingPR = await findOpenPR(octokit, owner, repo, WORKFLOW_BRANCH);
  if (existingPR) {
    await createComment(
      octokit,
      owner,
      repo,
      issueNumber,
      `Please merge PR #${existingPR.number} first for Bonk to run workflows.\n\n${existingPR.url}`,
    );

    return {
      exists: false,
      prUrl: existingPR.url,
      prNumber: existingPR.number,
    };
  }

  const baseSha = await getDefaultBranchSha(octokit, owner, repo, defaultBranch);

  try {
    await createBranch(octokit, owner, repo, WORKFLOW_BRANCH, baseSha);
  } catch (error) {
    // Branch may exist from a previous closed PR
    const errorMessage = error instanceof Error ? error.message : "";
    if (!errorMessage.includes("Reference already exists")) {
      throw error;
    }
  }

  const workflowContent = generateWorkflowContent();
  await createOrUpdateFile(
    octokit,
    owner,
    repo,
    WORKFLOW_FILE_PATH,
    workflowContent,
    "Add Bonk workflow file",
    WORKFLOW_BRANCH,
  );

  const prBody = `## Summary

This PR adds the Bonk GitHub Action workflow to enable \`@ask-bonk\` / \`/bonk\` mentions in issues and PRs.

## Setup Required

After merging, ensure the following secret is set in your repository:

1. Go to **Settings** > **Secrets and variables** > **Actions**
2. Add a new repository secret:
   - **Name**: \`OPENCODE_API_KEY\`
   - **Value**: Your Anthropic API key (get one at https://console.anthropic.com/)

## Usage

Once merged and configured, mention the bot in any issue or PR:

\`\`\`
@ask-bonk fix the type error in utils.ts
\`\`\`

Or use the slash command:

\`\`\`
/bonk add tests for the new feature
\`\`\`
`;

  const prNumber = await createPullRequest(
    octokit,
    owner,
    repo,
    WORKFLOW_BRANCH,
    defaultBranch,
    "Add Bonk workflow",
    prBody,
  );

  const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;

  await createComment(
    octokit,
    owner,
    repo,
    issueNumber,
    `I noticed the workflow file is missing. I've created a PR to add it: #${prNumber}\n\nOnce merged and configured with your \`OPENCODE_API_KEY\` secret, mention me again!\n\n${prUrl}`,
  );

  return {
    exists: false,
    prUrl,
    prNumber,
  };
}
