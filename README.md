# ask-bonk

<p align="center">
  <img src="bonk_logo.png" alt="Bonk Logo" width="200">
</p>

Just `/bonk` it.

It's a code (and docs!) review agent that responds to mentions in issues and PRs. Built on [OpenCode](https://github.com/sst/opencode), Bonk can review code, answer questions about your codebase, and make changes directly by opening PRs and telling you where you can do better.

- **Code & doc review** - Get feedback on PRs, explain code, or ask questions about your repo just by mentioning `/bonk` in an issue, PR comment or even line comments.
- **Make changes** - Bonk can edit files and create PRs from issues and update PRs.
- **Fully configurable** - Supports any [model provider](https://opencode.ai/docs/providers) that OpenCode does (Anthropic, OpenAI, Google, etc.). Why reinvent the wheel when there's a perfectly round one already?

## Installation

> :bangbang: The hosted Bonk instance only runs on a handful of repos (`elithrar/*`, `cloudflare/*`, and `ask-bonk/*`). Installing Bonk on repositories outside these orgs will result in the installation being automatically rejected. The app & action are public as GitHub doesn't support an allowlist for app installs: just same-org or "anyone".

> **To use Bonk on your own repos**, you'll need to create your own GitHub app and [self-host](#self-hosting) your own instance.

### Using the CLI (recommended)

The CLI handles app installation, API key setup, and workflow creation. Clone the repo and run:

```bash
bun run cli install
```

Or add new workflows to an existing installation:

```bash
bun run cli workflow
```

### Manual Installation

#### 1. Install the GitHub App

Install the [ask-bonk GitHub App](https://github.com/apps/ask-bonk) on your repository.

#### 2. Add the Workflow File

Create a simple `.github/workflows/bonk.yml` in your repository:

```yaml
name: Bonk

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  bonk:
    if: github.event.sender.type != 'Bot'
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: write
      issues: write
      pull-requests: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Run Bonk
        uses: ask-bonk/ask-bonk/github@main
        env:
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }} # or the supported provider of your choice
        with:
          model: "opencode/claude-opus-4-5"
          mentions: "/bonk,@ask-bonk"
```

#### 3. Add Your API Key

Add `OPENCODE_API_KEY` to your repository secrets (**Settings** > **Secrets and variables** > **Actions**) - [get one here](https://opencode.ai/api-keys)

#### 4. Start Using Bonk

Mention `@ask-bonk` or `/bonk` in any issue or PR comment.

### Using Other Providers

[Any OpenCode provider](https://opencode.ai/docs/providers/) is supported. Update your `bonk.yml` workflow file to specify a different model and pass the appropriate API key:

```yaml
- name: Run Bonk
  uses: ask-bonk/ask-bonk/github@main
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  with:
    model: anthropic/claude-sonnet-4-20250514
```

You can also configure Bonk to use [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/):

```yaml
- name: Run Bonk
  uses: ask-bonk/ask-bonk/github@main
  env:
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    CLOUDFLARE_GATEWAY_ID: ${{ secrets.CLOUDFLARE_GATEWAY_ID }}
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  with:
    model: cloudflare-ai-gateway/anthropic/claude-opus-4-5
```

## GitHub Workflows

Mention the bot in any issue or PR:

```
@ask-bonk fix the type error in utils.ts
```

Or use the slash command:

```
/bonk add tests for the auth module
```

For more complex tasks, use a multi-line prompt:

```
/bonk put a plan together:

- add new tests that mock our Durable Objects as per
  https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/
- ensure there is at least one test for each RPC method on the class
- add a withRetry<T> util that can wrap any upstream GitHub API call and
  retry up to retries: number times with a timeoutSeconds: number
- check our error handling - call out cases where we are incorrectly catching
  exceptions and/or not attempting to retry remote operations
```

### Examples

- `@ask-bonk review this PR` - Get a code review
- `/bonk explain how the auth system works` - Ask questions about the codebase
- `@ask-bonk fix the failing tests` - Let Bonk make changes and push commits
- `/bonk add documentation for the API endpoints` - Generate documentation
- `/bonk add the --format="json" flag to the export subcommand and update the product/docs repo CLI docs to show the usage` - Make changes across one (or more!) repos in your org using the `cross-repo` tool

### Supported Events

The default workflow triggers on `issue_comment` and `pull_request_review_comment` events. You can extend your workflow to support additional events:

| Event                         | Trigger                                          | How it works                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `issue_comment`               | `/bonk` or `@ask-bonk` in an issue or PR comment | Bonk responds to mentions in the comment thread. Works for both issues and pull requests.                                                                                                        |
| `pull_request_review_comment` | `/bonk` or `@ask-bonk` in a PR line comment      | Bonk responds with full diff context from the specific line being commented on. Ideal for targeted code review questions.                                                                        |
| `pull_request_review`         | `/bonk` or `@ask-bonk` in a PR review body       | Triggered when a review is submitted with the mention in the review body. Add `pull_request_review: types: [submitted]` to your workflow triggers.                                               |
| `issues`                      | New issue opened                                 | Automatically responds to newly created issues. Useful for triage or auto-labeling. Requires adding `issues: types: [opened]` to triggers and removing the mention check from the job condition. |
| `schedule`                    | Cron expression                                  | Runs automated tasks on a schedule. The prompt comes from the workflow file's `prompt` input.                                                                                                    |
| `workflow_dispatch`           | Manual trigger in Actions UI                     | Runs tasks on-demand via the GitHub Actions interface.                                                                                                                                           |

#### Adding a `/review` Command

```yaml
- name: Run Bonk
  uses: ask-bonk/ask-bonk/github@main
  env:
    OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
  with:
    model: "opencode/claude-opus-4-5"
    mentions: "/review"
    prompt: |
      Review this PR for bugs, security issues, and style. Leave suggestions
      on specific line numbers. Consider the wider context of each file and
      follow the repository's existing conventions.
```

#### Scheduled Tasks

```yaml
on:
  schedule:
    - cron: "0 4 * * 5" # Friday at 4AM UTC

jobs:
  update-deps:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: write
      issues: write
      pull-requests: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Run Bonk
        uses: ask-bonk/ask-bonk/github@main
        env:
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
        with:
          model: "opencode/claude-opus-4-5"
          prompt: |
            Update all dependencies to their latest compatible versions.
            Run tests and type-check after updating.
```

## `/stats` Endpoint

A public endpoint that displays event metrics as an ASCII bar chart (or JSON).

```bash
# ASCII bar chart (default)
curl https://ask-bonk.silverlock.workers.dev/stats

# JSON format
curl https://ask-bonk.silverlock.workers.dev/stats?format=json
```

**Example output:**

```
Events per repo (last 30d)
──────────────────────────────────────────────────────────────
ask-bonk/ask-bonk (webhook)   | ████████████████████████████████████████ | 150
sst/ion (track)               | ████████████████████████                 | 89
sst/ion (webhook)             | ████████████████████                     | 75
ask-bonk/ask-bonk (finalize)  | ████████████                             | 45
```

## `/ask` Sandbox Mode

> :warning: **Experimental and work-in-progress.** Uses the [Cloudflare Sandbox SDK](https://sandbox.cloudflare.com/) to run off-GitHub tasks.

For programmatic access, Bonk exposes an `/ask` endpoint that runs OpenCode directly in a Cloudflare Sandbox. This allows you to integrate Bonk into your own workflows, scripts, or applications without going through GitHub issues and PRs.

**Requirements:**

- The [ask-bonk GitHub App](https://github.com/apps/ask-bonk) must be installed on the target repository
- Set a secret for bearer auth: `openssl rand -hex 32 | tee >(npx wrangler@latest secret put ASK_SECRET)`

When you make a request to `/ask`:

1. Bonk clones your repository into an isolated sandbox
2. Runs OpenCode with your prompt against the codebase
3. Returns the response as a Server-Sent Events (SSE) stream

```bash
curl -N https://ask-bonk.silverlock.workers.dev/ask \
  -H "Authorization: Bearer $ASK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "owner": "your-org",
    "repo": "your-repo",
    "prompt": "Explain how the authentication system works"
  }'
```

Optional fields:

- `model` - Override the default model (e.g., `"anthropic/claude-sonnet-4-20250514"`)
- `agent` - Use a specific OpenCode agent
- `config` - Pass custom OpenCode configuration

## Config

Bonk is configured via your workflow file and OpenCode's config. There are no built-in defaults beyond what you specify.

### Workflow Inputs

| Input         | Description                                                   | Required |
| ------------- | ------------------------------------------------------------- | -------- |
| `model`       | Model to use (e.g., `opencode/claude-opus-4-5`)               | Yes      |
| `mentions`    | Comma-separated triggers (e.g., `/bonk,@ask-bonk`)            | No       |
| `permissions` | Required permission: `admin`, `write`, `any`, or `CODEOWNERS` | No       |
| `agent`       | OpenCode agent to use                                         | No       |
| `prompt`      | Custom prompt (for scheduled/dispatch workflows)              | No       |

### OpenCode Config

For advanced configuration (custom providers, system prompts, custom tools, etc.), create `.opencode/opencode.jsonc` in your repository. See [OpenCode docs](https://opencode.ai/docs/config) for all options.

```jsonc
{
  "provider": {
    "anthropic": {},
  },
  "model": {
    "default": "anthropic/claude-sonnet-4-20250514",
  },
}
```

## Self-Hosting

Deploy your own Bonk instance to Cloudflare Workers:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ask-bonk/ask-bonk)

You'll need to [create a GitHub App](https://docs.github.com/en/apps/creating-github-apps) with the following permissions:

- Contents: Read & Write
- Issues: Read & Write
- Metadata: Read
- Pull requests: Read & Write
- Workflows: Read & Write

Subscribe to webhook events: Issue comments, Pull request review comments, Pull request reviews.

Required secrets (set via `wrangler secret put`):

- `GITHUB_APP_ID` - Your GitHub App ID
- `GITHUB_APP_PRIVATE_KEY` - Your GitHub App private key (PEM format)
- `GITHUB_WEBHOOK_SECRET` - Webhook secret for verifying GitHub requests

BYO LLM keys: any [OpenCode supported provider](https://opencode.ai/docs/providers/) is, well, supported. Users provide their own API keys via repository secrets in their workflows.

## Contributing

This project is only slightly open to external contributions. Not all of them will be accepted, and that's OK :-)

## License

Apache-2.0 licensed.
