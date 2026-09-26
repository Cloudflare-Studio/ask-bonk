# ask-bonk

<p align="center">
  <img src="bonk_logo.png" alt="Bonk Logo" width="200">
</p>

Just `/bonk` it.

It's a code (and docs!) review agent that responds to mentions in issues and PRs. Built on [OpenCode](https://github.com/anomalyco/opencode) and [Flue](https://flueframework.com/), Bonk can review code, answer questions about your codebase, and make changes directly by opening PRs and telling you where you can do better.

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

Add `OPENCODE_API_KEY` to your repository secrets (**Settings** > **Secrets and variables** > **Actions**) - [get one here](https://opencode.ai/auth)

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

#### Token Scoping

By default, Bonk's installation token has full write access. Use `token_permissions` to restrict what the agent can do -- useful for review-only workflows where the agent should never push code.

```yaml
# Review-only: can comment and suggest, cannot push
- name: Run Bonk
  uses: ask-bonk/ask-bonk/github@main
  env:
    OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
  with:
    model: "opencode/claude-opus-4-5"
    mentions: "/review"
    token_permissions: NO_PUSH
```

`NO_PUSH` sets `contents: read` while keeping `issues: write` and `pull_requests: write` so the agent can still post comments and reviews. `WRITE` is the default (full access). You can also pass a custom JSON object for fine-grained control:

```yaml
token_permissions: '{"contents": "read", "pull_requests": "read"}'
```

Custom objects are merged with the defaults and each permission is clamped to the lower of the two -- callers can reduce permissions but never escalate. Invalid input (unknown presets, bad JSON, unrecognized values) fails closed to `NO_PUSH`.

#### Failure Comments

When a tracked Bonk run fails, times out, or is cancelled, Bonk posts a comment on the triggering issue or PR (and edits that comment in place if later runs also fail). Automated workflows, such as reviews on every push, can turn this off and rely on the workflow run status instead:

```yaml
- name: Run Bonk
  uses: ask-bonk/ask-bonk/github@main
  env:
    OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
  with:
    model: "opencode/claude-opus-4-5"
    failure_comment: "false"
```

With `failure_comment: "false"`, Bonk never posts a new failure comment, but it still edits a comment it already posted on the same issue or PR (a "waiting for approval" notice, or an earlier failure comment) to show the final status. The setting is stored when the run starts, so it also applies when Bonk detects the failure through its polling or `workflow_run` safety nets.

#### Re-reviews

By default every run reviews the pull request from scratch. Set `rereview_context: "true"` to make repeat reviews build on the previous one:

```yaml
- name: Run Bonk
  uses: ask-bonk/ask-bonk/github@main
  env:
    OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
  with:
    model: "opencode/claude-opus-4-5"
    rereview_context: "true"
```

On pull request runs, Bonk then adds a `<bonk_previous_review>` block to the prompt with:

- the head SHA Bonk last reviewed and what the author changed since then. Bonk compares the pull request's diff against its merge base at the last review with the diff now, file by file, ignoring hunk line numbers. Files whose pull request diff is unchanged drop out, so changes merged in from the base branch (or a rebase onto it) are not re-reviewed. The block lists the remaining files and gives a command for the author's delta: `git diff <last_head> <head>` when the merge base is unchanged, otherwise a per-file comparison of `git diff <old_merge_base> <last_head>` with `git diff <new_merge_base> <head>`;
- Bonk's previous summary;
- Bonk's inline review threads with GitHub's resolved and outdated state, including replies.

The harness guidance tells OpenCode to review only the author's delta, account for every previous finding, treat declined findings as resolved unless they block correctness or security, avoid new non-blocking findings on unchanged code, keep its verdict when only the base branch moved, and start its response with `Since last review: N resolved, M still open, K new.` Every review response, first or repeat, starts with a fixed verdict line: `LGTM!`, `Review: N findings.`, or `Since last review: …`.

Review runs also publish differently. Instead of calling the GitHub API, OpenCode writes its inline findings to a JSON file whose path Bonk puts in the prompt (`review_output_file`). After OpenCode finishes, Bonk:

- posts the findings as one review with an empty body, pinned to the reviewed commit. A finding whose line is not in the diff moves to the nearest commentable line within five lines; suggestions never move. Findings that still cannot be placed are listed in the summary under "Findings outside the diff";
- keeps one review summary comment per pull request. The first review's response becomes that comment. Later reviews rewrite it in place and delete their own new response comment, so the pull request never collects a stack of summaries. (`opencode github run` always posts the response first, so watchers may still get a notification for the comment that is then removed.) The comment ends with `Reviewed commit: <sha>` and a hidden `<!-- bonk-review-state:{...} -->` marker recording the reviewed head and base;
- checks the pull request head first. If it moved during the run, no inline review is posted: the findings go into the summary, with a note naming the commit the review covers.

A run counts as a review when OpenCode wrote the findings file, when it was triggered by a `pull_request` event, when Bonk submitted a pull request review during the run, or when the response starts with one of those verdict lines (`LGTM` without the bang is also accepted). Other responses, such as `/bonk explain ...`, stay normal comments and leave the last reviewed head unchanged. Before the first marker exists, Bonk uses the commit of its latest inline review.

Bonk recognizes its own comments, reviews, and markers by the GitHub App behind its installation token (GraphQL `viewer`), so self-hosted Apps need no extra configuration. `NO_PUSH` tokens have everything publishing needs (`issues: write` and `pull_requests: write`).

With `rereview_context` enabled, the prompt always carries the pull request's current head as `head_sha`. To review on every push, add `synchronize` to the `pull_request` trigger types and serialize runs per pull request:

```yaml
on:
  pull_request:
    types: [opened, ready_for_review, synchronize]

concurrency:
  group: bonk-review-${{ github.event.pull_request.number }}
  cancel-in-progress: false
```

GitHub keeps at most one pending run per concurrency group, so a burst of pushes produces one run for the in-flight head and one for the newest head. `cancel-in-progress: true` also works, but Bonk reports each cancelled in-flight run on the pull request unless `failure_comment` is `"false"`.

#### Version Pinning

By default, Bonk installs the latest OpenCode release. If a release is broken, you can pin to a known-good version:

```yaml
- name: Run Bonk
  uses: ask-bonk/ask-bonk/github@main
  env:
    OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
  with:
    model: "opencode/claude-opus-4-5"
    opencode_version: "1.2.16"
```

Accepts a semver string (e.g., `"1.2.16"`, `"1.2.16-beta.1"`), `"latest"`, or `"dev"`. Invalid input (including `v`-prefixed versions, incomplete versions, or strings containing shell metacharacters) silently falls back to `"latest"` with a warning in the workflow log.

The `opencode_dev` input takes precedence over `opencode_version` -- setting `opencode_dev: "true"` always installs from the dev channel regardless of the pinned version.

#### Timeouts and Retries

Bonk retries OpenCode after transient provider or network failures (dropped streams, connection resets) and stops it once the total time budget is spent. Both limits are configurable:

```yaml
jobs:
  bonk:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      # ...
      - name: Run Bonk
        uses: ask-bonk/ask-bonk/github@main
        env:
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
        with:
          model: "opencode/claude-opus-4-5"
          timeout: "25m" # total budget across all attempts: ms, s, m, or h
          retries: "1"
```

When the budget runs out, Bonk stops OpenCode and reports the run as timed out. Keep `timeout` a few minutes below the job's `timeout-minutes` (GitHub's default is 360). When the job limit is hit first, GitHub cancels the job mid-run: Bonk's reporting and credential cleanup steps may not run, and any failure comment says the run was cancelled rather than that OpenCode ran out of time. Timeouts, hangs, and cancellations are not retried: the budget covers all attempts, so a run that times out has no time left for another.

`OPENCODE_TIMEOUT` and `OPENCODE_RETRIES` environment variables are still honoured when the inputs are not set.

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
curl https://ask-bonk.cloudflare-exponent.workers.dev/stats

# JSON format
curl https://ask-bonk.cloudflare-exponent.workers.dev/stats?format=json
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

## Config

Bonk is configured via your workflow file and OpenCode's config. Its built-in harness guidance keeps OpenCode on the triggering target, assigns commit/push/PR lifecycle and top-level response delivery to `opencode github run`, and applies read-only working-tree behavior when repository writes are unavailable. Repository instructions and custom OpenCode instructions still apply.

### Workflow Inputs

| Input                | Description                                                                      | Required |
| -------------------- | -------------------------------------------------------------------------------- | -------- |
| `model`              | Model to use (e.g., `opencode/claude-opus-4-5`)                                  | Yes      |
| `mentions`           | Comma-separated triggers (e.g., `/bonk,@ask-bonk`)                               | No       |
| `permissions`        | Required permission: `admin`, `write`, `any`, or `CODEOWNERS`                    | No       |
| `token_permissions`  | Scope the installation token: `NO_PUSH`, `WRITE`, or JSON                        | No       |
| `opencode_version`   | Pin to a specific OpenCode version (e.g., `"1.2.16"`). Defaults to `"latest"`.   | No       |
| `opencode_dev`       | Install from the dev channel instead of latest release (`"true"` / `"false"`)    | No       |
| `timeout`            | Total OpenCode time budget including retries (e.g., `"30m"`). Defaults to `45m`. | No       |
| `retries`            | Retries after transient provider/network failures. Defaults to `2`.              | No       |
| `rereview_context`   | Context-aware re-reviews and one sticky review comment per PR (`"true"` / `"false"`) | No       |
| `agent`              | Legacy input; current OpenCode uses consumer `default_agent`, then `build`        | No       |
| `prompt`             | Task for scheduled/dispatch runs, or override for the triggering request         | No       |
| `variant`            | Model variant for provider-specific reasoning effort (e.g., `high`, `max`)       | No       |
| `forks`              | `"true"` (default): comment-only runs on fork PRs; `"false"`: skip them silently | No       |
| `failure_comment`    | Comment on the issue/PR when a run fails or is cancelled (`"true"` / `"false"`)  | No       |
| `oidc_base_url`      | OIDC token exchange URL, for self-hosted deployments. Defaults to the hosted app | No       |

### OpenCode Config

For advanced configuration (custom providers, system prompts, custom tools, etc.), create `opencode.jsonc` in your repository root. See [OpenCode docs](https://opencode.ai/docs/config) for all options.

```jsonc
{
  "provider": {
    "anthropic": {},
  },
  "model": "openai/gpt-5.6-sol",
}
```

## Self-Hosting

Deploy your own Bonk instance to Cloudflare Workers:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ask-bonk/ask-bonk)

For the maintained `ask-bonk.cloudflare-exponent.workers.dev` deployment, see
[DEPLOYMENT.md](./DEPLOYMENT.md).

You'll need to [create a GitHub App](https://docs.github.com/en/apps/creating-github-apps) with the following permissions:

- Actions: Read
- Contents: Read & Write
- Issues: Read & Write
- Metadata: Read
- Pull requests: Read & Write
- Workflows: Read & Write

Subscribe to webhook events: Issue comments, Pull request review comments, Pull request reviews, Workflow runs.

Required secrets (set via `wrangler secret put`):

- `GITHUB_APP_ID` - Your GitHub App ID
- `GITHUB_APP_PRIVATE_KEY` - Your GitHub App private key (PEM format)
- `GITHUB_WEBHOOK_SECRET` - Webhook secret for verifying GitHub requests

BYO LLM keys: any [OpenCode supported provider](https://opencode.ai/docs/providers/) is, well, supported. Users provide their own API keys via repository secrets in their workflows.

## Contributing

This project is only slightly open to external contributions. Not all of them will be accepted, and that's OK :-)

## License

Apache-2.0 licensed.
