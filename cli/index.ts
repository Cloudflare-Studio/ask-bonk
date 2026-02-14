#!/usr/bin/env bun
/**
 * Bonk CLI
 *
 * Commands:
 *   bonk install  - Install the GitHub App and set up API key
 *   bonk workflow - Add workflow files from presets
 */

import * as p from "@clack/prompts";
import * as fs from "fs";
import * as path from "path";
import {
  checkAppInstallation,
  commandExists,
  createBranch,
  createFile,
  createPR,
  findExistingPR,
  branchExists,
  getDefaultBranch,
  getGitOrigin,
  hasWorkflowScope,
  isGhAuthenticated,
  openUrl,
  repoExists,
  setSecret,
  waitForAppInstallation,
  workflowExists,
} from "./github";

const GITHUB_APP_URL = "https://github.com/apps/ask-bonk";
const DEFAULT_MODEL = "opencode/claude-opus-4-5";
const BOT_MENTION = "@ask-bonk";
const BOT_COMMAND = "/bonk";

type ProviderChoice = "opencode-zen" | "anthropic" | "openai" | "other";
type WorkflowPreset = "bonk" | "scheduled" | "triage" | "review" | "custom";
type EventTrigger =
  | "issue_comment"
  | "pull_request_review_comment"
  | "issues"
  | "pull_request"
  | "schedule"
  | "workflow_dispatch";

interface ProviderConfig {
  keyName: string;
  keyValue: string;
  model: string;
}

interface WorkflowConfig {
  name: string;
  filename: string;
  model: string;
  keyName: string;
  events: EventTrigger[];
  mentions?: string;
  prompt?: string;
  cron?: string;
  permissions: "read" | "write";
}

// Provider configurations
const PROVIDERS: Record<ProviderChoice, { name: string; keyName: string; defaultModel: string }> = {
  "opencode-zen": {
    name: "OpenCode Zen",
    keyName: "OPENCODE_API_KEY",
    defaultModel: "opencode/claude-opus-4-5",
  },
  anthropic: {
    name: "Anthropic",
    keyName: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-20250514",
  },
  openai: {
    name: "OpenAI",
    keyName: "OPENAI_API_KEY",
    defaultModel: "gpt-4o",
  },
  other: {
    name: "Other OpenCode supported provider",
    keyName: "",
    defaultModel: "",
  },
};

function loadTemplate(name: string): string {
  const templatePath = path.join(__dirname, "templates", `${name}.yml.hbs`);
  return fs.readFileSync(templatePath, "utf-8");
}

function writeWorkflowLocally(filename: string, content: string): string {
  const workflowDir = path.join(process.cwd(), ".github", "workflows");
  fs.mkdirSync(workflowDir, { recursive: true });
  const filePath = path.join(workflowDir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return result;
}

async function selectProvider(): Promise<ProviderConfig> {
  const provider = (await p.select({
    message: "Select your LLM provider",
    options: [
      { value: "opencode-zen", label: "OpenCode Zen", hint: "recommended" },
      { value: "anthropic", label: "Anthropic" },
      { value: "openai", label: "OpenAI" },
      { value: "other", label: "Other OpenCode supported provider" },
    ],
  })) as ProviderChoice;

  if (p.isCancel(provider)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  let keyName: string;
  let defaultModel: string;

  if (provider === "other") {
    const customKeyName = await p.text({
      message: "Enter the API key name (e.g. OPENROUTER_API_KEY)",
      validate: (v) => (v.length === 0 ? "Key name is required" : undefined),
    });
    if (p.isCancel(customKeyName)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }
    keyName = customKeyName;

    const customModel = await p.text({
      message: "Enter the model name",
      validate: (v) => (v.length === 0 ? "Model name is required" : undefined),
    });
    if (p.isCancel(customModel)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }
    defaultModel = customModel;
  } else {
    keyName = PROVIDERS[provider].keyName;
    defaultModel = PROVIDERS[provider].defaultModel;
  }

  const apiKey = await p.password({
    message: `Enter your ${keyName}`,
    validate: (v) => (v.length === 0 ? "API key is required" : undefined),
  });

  if (p.isCancel(apiKey)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  return { keyName, keyValue: apiKey, model: defaultModel };
}

async function runInstall() {
  p.intro("Bonk Install");

  // Check prerequisites
  if (!commandExists("gh")) {
    p.log.error("GitHub CLI (gh) is required but not installed.");
    p.log.info("Install it from: https://cli.github.com/");
    process.exit(1);
  }

  if (!isGhAuthenticated()) {
    p.log.error("GitHub CLI is not authenticated.");
    p.log.info("Run: gh auth login");
    process.exit(1);
  }

  p.log.success("GitHub CLI is installed and authenticated");

  let canWriteRemote = hasWorkflowScope();
  if (!canWriteRemote) {
    p.log.warn("GitHub CLI missing 'workflow' scope");
    p.log.info("Run: gh auth refresh -h github.com -s workflow");
    const proceed = await p.confirm({
      message: "Write workflow files to current directory instead?",
    });
    if (p.isCancel(proceed)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }
    canWriteRemote = !proceed;
  }

  // Get target repository
  const detectedRepo = getGitOrigin();
  const targetRepo = await p.text({
    message: "Repository (owner/repo)",
    initialValue: detectedRepo || "",
    validate: (v) => {
      if (!v || !v.includes("/")) return "Invalid repository format. Use owner/repo";
      return undefined;
    },
  });

  if (p.isCancel(targetRepo)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  if (!repoExists(targetRepo)) {
    p.log.error(`Cannot access repository ${targetRepo}. Check it exists and you have access.`);
    process.exit(1);
  }

  p.log.success(`Repository ${targetRepo} exists and is accessible`);

  // Check GitHub App installation
  const spinner = p.spinner();
  spinner.start("Checking GitHub App installation...");

  const isAppInstalled = await checkAppInstallation(targetRepo);

  if (isAppInstalled) {
    spinner.stop("ask-bonk GitHub App is already installed");
  } else {
    spinner.stop("GitHub App not installed");
    p.log.info(`Install the app: ${GITHUB_APP_URL}`);

    openUrl(GITHUB_APP_URL);

    spinner.start("Waiting for app installation (checking every 10s for up to 2 mins)...");
    const installed = await waitForAppInstallation(targetRepo);

    if (!installed) {
      spinner.stop("App installation not detected");
      p.log.error(`Install the app manually: ${GITHUB_APP_URL}`);
      process.exit(1);
    }

    spinner.stop("GitHub App installed successfully");
  }

  // Select provider and get API key
  const providerConfig = await selectProvider();

  // Set secret
  const setSecretConfirm = await p.confirm({
    message: `Set ${providerConfig.keyName} as a repository secret using gh CLI?`,
  });

  if (p.isCancel(setSecretConfirm)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  if (setSecretConfirm) {
    spinner.start(`Setting ${providerConfig.keyName} secret...`);
    if (setSecret(targetRepo, providerConfig.keyName, providerConfig.keyValue)) {
      spinner.stop(`${providerConfig.keyName} secret set successfully`);
    } else {
      spinner.stop("Failed to set secret");
      p.log.warn(`Set it manually at: https://github.com/${targetRepo}/settings/secrets/actions`);
    }
  } else {
    p.log.info(
      `Set ${providerConfig.keyName} manually at: https://github.com/${targetRepo}/settings/secrets/actions`,
    );
  }

  // Ask to add workflows
  const addWorkflows = await p.confirm({
    message: "Would you like to add workflow files now?",
  });

  if (p.isCancel(addWorkflows)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  if (addWorkflows) {
    await runWorkflow(targetRepo, providerConfig, canWriteRemote);
  }

  p.outro("Setup complete! Run `bonk workflow` to add more workflows.");
}

async function runWorkflow(
  repo?: string,
  providerConfig?: ProviderConfig,
  canWriteRemote: boolean = true,
) {
  if (!repo) {
    p.intro("Bonk Workflow");

    // Check workflow scope upfront when running standalone
    if (!hasWorkflowScope()) {
      p.log.warn("GitHub CLI missing 'workflow' scope");
      p.log.info("Run: gh auth refresh -h github.com -s workflow");
      const proceed = await p.confirm({
        message: "Write workflow files to current directory instead?",
      });
      if (p.isCancel(proceed)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
      }
      canWriteRemote = !proceed;
    }

    const detectedRepo = getGitOrigin();
    const targetRepo = await p.text({
      message: "Repository (owner/repo)",
      initialValue: detectedRepo || "",
      validate: (v) => {
        if (!v || !v.includes("/")) return "Invalid repository format. Use owner/repo";
        return undefined;
      },
    });

    if (p.isCancel(targetRepo)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }

    repo = targetRepo;
  }

  let addAnother = true;

  while (addAnother) {
    const preset = (await p.select({
      message: "Select a workflow preset",
      options: [
        {
          value: "bonk",
          label: "bonk",
          hint: "mention-triggered interactive assistant",
        },
        {
          value: "scheduled",
          label: "scheduled",
          hint: "run on a schedule (e.g. weekly updates)",
        },
        { value: "triage", label: "triage", hint: "run on new issues" },
        {
          value: "review",
          label: "review",
          hint: "on-demand PR review via /review",
        },
        {
          value: "custom",
          label: "make my own",
          hint: "custom event triggers",
        },
      ],
    })) as WorkflowPreset;

    if (p.isCancel(preset)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }

    let config: WorkflowConfig;

    if (preset === "custom") {
      config = await buildCustomWorkflow(providerConfig);
    } else {
      config = await buildPresetWorkflow(preset, providerConfig);
    }

    // Generate workflow content
    const template = loadTemplate(preset === "custom" ? "custom" : preset);
    const content = renderTemplate(template, {
      NAME: config.name,
      MODEL: config.model,
      KEY_NAME: config.keyName,
      MENTIONS: config.mentions || "",
      PROMPT: config.prompt || "",
      CRON: config.cron || "0 0 * * 1",
      PERMISSIONS: config.permissions,
      BOT_COMMAND,
      BOT_MENTION,
      EVENTS: config.events
        .map((e) => {
          if (e === "issue_comment" || e === "pull_request_review_comment") {
            return `  ${e}:\n    types: [created]`;
          } else if (e === "issues") {
            return `  issues:\n    types: [opened]`;
          } else if (e === "pull_request") {
            return `  pull_request:\n    types: [opened]`;
          } else if (e === "schedule") {
            return `  schedule:\n    - cron: "${config.cron || "0 0 * * 1"}"`;
          } else if (e === "workflow_dispatch") {
            return `  workflow_dispatch: {}`;
          }
          return "";
        })
        .join("\n"),
    });

    const workflowPath = `.github/workflows/${config.filename}`;

    if (!canWriteRemote) {
      // Write locally when gh doesn't have workflow permissions
      const localPath = writeWorkflowLocally(config.filename, content);
      p.log.success(`Workflow written to ${localPath}`);
      p.log.info("Commit and push to enable the workflow");
    } else {
      // Check if workflow exists
      if (workflowExists(repo!, workflowPath)) {
        const overwrite = await p.confirm({
          message: `Workflow ${config.filename} already exists. Overwrite?`,
        });
        if (p.isCancel(overwrite) || !overwrite) {
          p.log.info("Skipping workflow creation");
          continue;
        }
      }

      // Create workflow via PR
      const defaultBranch = getDefaultBranch(repo!);
      const branchName = `bonk/add-${config.filename.replace(".yml", "")}`;

      // Check for existing PR
      const existingPR = findExistingPR(repo!, branchName);
      if (existingPR) {
        p.log.warn(`PR already exists: ${existingPR}`);
        const proceed = await p.confirm({ message: "Update the existing PR?" });
        if (p.isCancel(proceed) || !proceed) {
          continue;
        }
      }

      const spinner = p.spinner();
      spinner.start("Creating workflow...");

      // Create branch if needed
      if (!branchExists(repo!, branchName)) {
        if (!createBranch(repo!, branchName, defaultBranch)) {
          spinner.stop("Failed to create branch");
          continue;
        }
      }

      // Create file
      if (!createFile(repo!, workflowPath, content, `Add ${config.name} workflow`, branchName)) {
        spinner.stop("Failed to create workflow file");
        continue;
      }

      // Create PR if it doesn't exist
      if (!existingPR) {
        const prBody = `## Summary\n\nAdds the ${config.name} Bonk workflow.\n\n## Usage\n\n${getUsageDescription(preset, config)}`;
        const prUrl = createPR(
          repo!,
          branchName,
          defaultBranch,
          `Add ${config.name} workflow`,
          prBody,
        );

        if (prUrl) {
          spinner.stop(`Created PR: ${prUrl}`);
        } else {
          spinner.stop("Workflow file created, but PR creation failed");
          p.log.info(`Create PR manually: https://github.com/${repo}/compare/${branchName}`);
        }
      } else {
        spinner.stop("Updated existing PR");
      }
    }

    const another = await p.confirm({
      message: "Add another workflow?",
      initialValue: false,
    });

    if (p.isCancel(another)) {
      break;
    }

    addAnother = another;
  }

  if (!repo) {
    if (canWriteRemote) {
      p.outro("Don't forget to merge the PR(s) to enable your workflows!");
    } else {
      p.outro("Commit and push workflow files to enable them");
    }
  }
}

async function buildPresetWorkflow(
  preset: WorkflowPreset,
  providerConfig?: ProviderConfig,
): Promise<WorkflowConfig> {
  const defaults: Record<string, Partial<WorkflowConfig>> = {
    bonk: {
      name: "Bonk",
      filename: "bonk.yml",
      events: ["issue_comment", "pull_request_review_comment"],
      mentions: `${BOT_COMMAND},${BOT_MENTION}`,
      permissions: "write",
    },
    scheduled: {
      name: "Scheduled Update",
      filename: "bonk-scheduled.yml",
      events: ["schedule", "workflow_dispatch"],
      cron: "0 0 * * 1",
      permissions: "write",
    },
    triage: {
      name: "Issue Triage",
      filename: "bonk-triage.yml",
      events: ["issues"],
      permissions: "write",
    },
    review: {
      name: "Review",
      filename: "bonk-review.yml",
      events: ["issue_comment", "pull_request_review_comment"],
      mentions: "/review",
      permissions: "write",
    },
  };

  const presetDefaults = defaults[preset];

  const name = await p.text({
    message: "Workflow name",
    initialValue: presetDefaults.name,
  });

  if (p.isCancel(name)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  const filename = await p.text({
    message: "Filename",
    initialValue: presetDefaults.filename,
    validate: (v) => (!v.endsWith(".yml") ? "Filename must end with .yml" : undefined),
  });

  if (p.isCancel(filename)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  const model = await p.text({
    message: "Model",
    initialValue: providerConfig?.model || DEFAULT_MODEL,
  });

  if (p.isCancel(model)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  let cron = presetDefaults.cron;
  if (preset === "scheduled") {
    const cronInput = await p.text({
      message: "Cron expression",
      initialValue: presetDefaults.cron,
    });
    if (p.isCancel(cronInput)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }
    cron = cronInput;
  }

  return {
    name,
    filename,
    model,
    keyName: providerConfig?.keyName || "OPENCODE_API_KEY",
    events: presetDefaults.events!,
    mentions: presetDefaults.mentions,
    cron,
    permissions: presetDefaults.permissions!,
  };
}

async function buildCustomWorkflow(providerConfig?: ProviderConfig): Promise<WorkflowConfig> {
  const name = await p.text({
    message: "Workflow name",
    validate: (v) => (v.length === 0 ? "Name is required" : undefined),
  });

  if (p.isCancel(name)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  const filename = await p.text({
    message: "Filename",
    initialValue: `${name.toLowerCase().replace(/\s+/g, "-")}.yml`,
    validate: (v) => (!v.endsWith(".yml") ? "Filename must end with .yml" : undefined),
  });

  if (p.isCancel(filename)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  const events = (await p.multiselect({
    message: "Select event triggers",
    options: [
      {
        value: "issue_comment",
        label: "Issue comment",
        hint: "on new issue comments",
      },
      {
        value: "pull_request_review_comment",
        label: "PR review comment",
        hint: "on PR review comments",
      },
      { value: "issues", label: "New issues", hint: "on issue creation" },
      { value: "pull_request", label: "New PRs", hint: "on PR creation" },
      { value: "schedule", label: "Schedule", hint: "run on a cron schedule" },
      {
        value: "workflow_dispatch",
        label: "Manual trigger",
        hint: "allow manual runs",
      },
    ],
    required: true,
  })) as EventTrigger[];

  if (p.isCancel(events)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  let mentions: string | undefined;
  const hasCommentTriggers =
    events.includes("issue_comment") || events.includes("pull_request_review_comment");

  if (hasCommentTriggers) {
    const mentionsInput = await p.text({
      message: "Trigger mentions (comma-separated)",
      initialValue: `${BOT_COMMAND},${BOT_MENTION}`,
    });
    if (p.isCancel(mentionsInput)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }
    mentions = mentionsInput;
  }

  let cron: string | undefined;
  if (events.includes("schedule")) {
    const cronInput = await p.text({
      message: "Cron expression",
      initialValue: "0 0 * * 1",
    });
    if (p.isCancel(cronInput)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }
    cron = cronInput;
  }

  const promptSource = (await p.select({
    message: "Prompt source",
    options: [
      {
        value: "comment",
        label: "Comment body",
        hint: "use the triggering comment as the prompt",
      },
      {
        value: "issue",
        label: "Issue body",
        hint: "use the issue body as the prompt",
      },
      {
        value: "custom",
        label: "Custom prompt",
        hint: "provide a custom prompt",
      },
    ],
  })) as "comment" | "issue" | "custom";

  if (p.isCancel(promptSource)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  let prompt: string | undefined;
  if (promptSource === "custom") {
    const customPrompt = await p.text({
      message: "Enter your prompt",
      validate: (v) => (v.length === 0 ? "Prompt is required" : undefined),
    });
    if (p.isCancel(customPrompt)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }
    prompt = customPrompt;
  }

  const model = await p.text({
    message: "Model",
    initialValue: providerConfig?.model || DEFAULT_MODEL,
  });

  if (p.isCancel(model)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  const permissions = (await p.select({
    message: "Permissions",
    options: [
      {
        value: "write",
        label: "Write",
        hint: "can create commits, branches, PRs",
      },
      { value: "read", label: "Read-only", hint: "can only read and comment" },
    ],
  })) as "read" | "write";

  if (p.isCancel(permissions)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  return {
    name,
    filename,
    model,
    keyName: providerConfig?.keyName || "OPENCODE_API_KEY",
    events,
    mentions,
    prompt,
    cron,
    permissions,
  };
}

function getUsageDescription(preset: WorkflowPreset, config: WorkflowConfig): string {
  switch (preset) {
    case "bonk":
      return `Mention the bot in any issue or PR:\n\n\`\`\`\n${BOT_COMMAND} fix the type error\n\`\`\``;
    case "scheduled":
      return "This workflow runs on the configured schedule or can be triggered manually.";
    case "triage":
      return "This workflow runs automatically when new issues are created.";
    case "review":
      return `Request a review by commenting:\n\n\`\`\`\n/review\n\`\`\``;
    case "custom":
      if (config.mentions) {
        return `Trigger with: ${config.mentions}`;
      }
      return "See the workflow configuration for trigger details.";
    default:
      return "";
  }
}

async function showMenu() {
  p.intro(
    "Bonk CLI: a command-line helper for installing Bonk, a code-review tool build on OpenCode",
  );

  const action = await p.select({
    message: "What would you like to do?",
    options: [
      {
        value: "install",
        label: "Install",
        hint: "install the Bonk app + a workflow on a repo",
      },
      {
        value: "workflow",
        label: "Workflow",
        hint: "create additional Bonk workflows",
      },
    ],
  });

  if (p.isCancel(action)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  if (action === "install") {
    await runInstall();
  } else {
    await runWorkflow();
  }
}

// CLI entry point
const command = process.argv[2];

switch (command) {
  case "install":
    runInstall();
    break;
  case "workflow":
    runWorkflow();
    break;
  case "--help":
  case "-h":
    console.log(`
Bonk CLI

Commands:
  bonk install   Install the GitHub App and configure API keys
  bonk workflow  Add workflow files from presets

Options:
  --help, -h     Show this help message
`);
    break;
  case undefined:
    showMenu();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.log("Run `bonk --help` for usage");
    process.exit(1);
}
