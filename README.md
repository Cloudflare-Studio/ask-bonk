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

Review runs also get the diff precomputed. Preflight lists the pull request's files from GitHub (the diff against the merge base, as GitHub shows it) and writes one patch per file plus a `manifest.json` (path, status, additions, deletions, patch file, and a category: code, tests, docs, build, or config) under `$RUNNER_TEMP`. The prompt's `<bonk_diff>` block inlines every patch when they total under about 150 KB and otherwise lists the patch files to read; the model is told not to recompute the diff with git. The re-review author delta works the same way: each changed file's patch at the last review and now, inline under about 50 KB. The publisher places inline comments on exactly these hunks.

A built-in filter leaves out files that rarely need review and lists them at the end of the block: lockfiles, vendored directories (`vendor/`, `third_party/`, `node_modules/`), minified and bundled files, source maps, and files marked as generated (`@generated`, `DO NOT EDIT`, `Code generated by`). Files under `migrations/` are never filtered. Add your own with `ignore_paths`:

```yaml
    ignore_paths: |
      types/generated-snapshot/
      src/**/*.snap
```

Patterns are relative to the repository root and match whole paths: `*` stays within one path segment, `**` (a whole segment) spans any number of segments, and a trailing `/` covers a directory. Patterns may use letters, digits, `.`, `_`, `-`, `+`, `@`, `~`, `/`, and `*`; leading `/`, `..`, `?`, brackets, and negation are not allowed, and no pattern may cover `.github/workflows/`. Invalid patterns are skipped with a warning.

#### Specialists

With `rereview_context` enabled, reviews also use specialist reviewers. Before the main OpenCode run, Bonk starts one `opencode run --agent <specialist>` process per selected specialist, in parallel (`specialist_parallelism`, default 10), the ones with the largest budgets and the most code first. Each one:

- sees only the patches in its scope and a checkout of the pull request head;
- runs read-only: editing, web access, spawning other agents, and GitHub commands are denied, and it gets no GitHub token; LSP and snapshots are off to save memory;
- has its own time budget (5 minutes; 10 for correctness and security) and a stall watchdog. A specialist that produces no output for 3 minutes between model steps (6 minutes inside a step, where a reasoning model may be quiet before its first token) is stopped and retried once. Specialists are asked to write their findings file early and keep it updated, so one that runs out of time still contributes what it found;
- writes findings in the same format as the main run, severities included;
- gets its own OpenCode data directory (`XDG_DATA_HOME`), seeded with the credentials `opencode auth login` stores there, so processes starting together do not contend for one database. Launches are spaced a second apart, and a failed attempt's stderr is logged.

Each specialist is an OpenCode process that uses a few hundred MB of memory, so ten at once fit a standard GitHub-hosted runner (16 GB); lower `specialist_parallelism` on smaller self-hosted runners.

Bonk picks specialists in code from the diff, not with a model. Changes of at most 10 lines are reviewed by the main run alone. Up to 300 lines get correctness plus the specialists relevant to what changed (tests when tests changed, docs when docs changed). Larger changes get every relevant built-in: correctness, security, performance, api-compat, tests, and docs. Security also runs on any change that touches sensitive paths (auth, crypto, secrets, keys, tokens, `.env`, workflows). Filtered files do not count.

The main run then acts as the judge: it receives every specialist finding as an unverified claim, checks each against the code, merges findings about the same defect, keeps verified dead-code and duplication findings as notes, drops wrong or speculative ones and anything CI already checks (build and expansion errors, type errors, lints, formatting, failing tests), keeps or lowers severities (never raises them), adds verified defects the specialists missed, and writes the single findings file Bonk publishes. Each specialist finding has an id (`correctness#2`); the judge lists the ids each of its findings comes from in `sources` and gives a one-line reason for each one it drops in `specialist_dispositions`. Bonk logs what happened to every specialist finding and lists the ones not posted, with the judge's reasons, in a collapsed "Specialist findings not posted" section of the summary; a finding the judge neither kept nor dropped is listed as not accounted for. A specialist that did not finish is listed in the summary as `<area>: not reviewed (<reason>)`. The whole step is limited by `specialist_timeout` (default 15m), so budget it within the job's `timeout-minutes`.

Repositories can add their own specialists as Markdown files in `.github/bonk/specialists/`. Bonk reads them from the pull request's base commit, so a pull request cannot change the instructions its own review uses:

```markdown
---
name: jsg-safety          # lowercase letters, digits, and dashes
description: JSG binding and GC safety
paths:                    # optional; same pattern language as ignore_paths
  - src/workerd/jsg/**
  - src/workerd/api/**/*.h
budget: 8m                # optional; default 5m
model: provider/model     # optional
variant: high             # optional
---
What to look for, in plain language. This becomes the specialist's instructions.
```

On re-reviews, the review-state marker records each specialist's result after the judge: `issues` only if the judge kept one of its findings, `ok` otherwise. A specialist whose files the author has not changed since its last successful run is not run again: its earlier findings stand (their threads stay as they are) and the summary lists it as carried forward, or as not re-run when it had no findings. Scope is by file, so a specialist without `paths` covers every code file and re-runs whenever the author changed any; it then reviews only those changes (see below). Correctness and security always run, and any doubt (a first review, an unknown change set, or a specialist that did not finish last time) means the specialist runs.

Specialists and the judge share one scope. When every specialist that runs finished a review of this pull request before, the re-review covers the author's changes since the last review: a re-run specialist sees only its files the author changed, with each file's patch at the last review and now (correctness and security see all of their files but report only what those changes introduced), and the judge keeps to the same changes. When any of them never did, because the last review ran without specialists, the change grew into a larger tier, or a specialist did not finish last time, the re-review covers the whole pull request, for the specialists and the judge alike. The judge still follows up on every earlier thread either way.

A `README.md` in that directory is ignored, so it can document the specialists. A `SHARED.md` there holds rules that apply to every review: its text is added to every specialist's prompt and handed to the judge, so common rules (what not to report, severity calibration) live in one place instead of being repeated in each specialist. A repository specialist runs whenever the change is larger than trivial and touches its `paths` (or any code, without `paths`). One named like a built-in replaces it; without `paths` it keeps the built-in's scope (a `docs` replacement still reviews documentation files).

To turn a built-in off, add a file that names it with `enabled: false`:

```markdown
---
name: performance
enabled: false
---
Optional prose, for example why it is off. It is ignored.
```

A disabled specialist never runs, not under `auto` and not when an explicit `specialists` list names it (Bonk logs a warning). The judge is told which areas are off and raises no findings in them.

| Input                    | Default | Description                                                     |
| ------------------------ | ------- | --------------------------------------------------------------- |
| `specialists`            | `auto`  | `auto`, `off` (single-agent reviews), or a comma-separated list |
| `specialist_parallelism` | `10`    | Specialists running at once                                     |
| `specialist_timeout`     | `15m`   | Total time for the specialist step                              |
| `specialist_model`       | (model) | Model for specialists                                           |
| `specialist_variant`     | (variant) | Variant for specialists                                       |

Review runs also publish differently. Instead of calling the GitHub API, OpenCode writes its inline findings to a JSON file whose path Bonk puts in the prompt (`review_output_file`). After OpenCode finishes, Bonk:

- posts the findings as one review with an empty body, pinned to the reviewed commit. A finding whose line is not in the diff moves to the nearest commentable line within five lines; suggestions never move. Findings that still cannot be placed are listed in the summary under "Findings outside the diff";
- keeps one review summary comment per pull request. The first review's response becomes that comment, unless the pull request already has a review summary Bonk posted before it kept a marker (a Bonk comment with the run link that opens with a verdict line or "I'm Bonk, and I've done a quick review"); that comment is taken over instead, so an outdated summary does not stay next to the new one. Answers to other requests are never taken over. Later reviews rewrite it in place and delete their own new response comment, so the pull request never collects a stack of summaries. (`opencode github run` always posts the response first, so watchers may still get a notification for the comment that is then removed.) The comment ends with `Reviewed commit: <sha>` and a hidden `<!-- bonk-review-state:{...} -->` marker recording the reviewed head and base;
- checks the pull request head first. If it moved during the run, no inline review is posted and no threads are touched: the findings go into the summary, with a note naming the commit the review covers.

Every finding in the file has a severity: `blocking`, `warning`, `info`, `suggestion`, or `question`. Blocking and warning findings are defects the author should act on, so they go inline; info, suggestion, and question findings are listed in the summary under "Other findings", which keeps the diff to what needs a change. Bonk applies the severity rules itself: a finding built from specialist findings is capped at the most severe of its `sources` (the judge may lower a specialist's severity, never raise it), a new `blocking` finding without `evidence` (one line on how it was verified) becomes a warning, findings the code explicitly justifies drop one level (never below `suggestion`), findings in test files are dropped unless they are blocking or a warning, and a review asks at most one question. Only blocking and warning findings count toward the verdict (`Review: 2 findings (1 blocking, 1 warning; 3 notes).`); a review with only notes is `LGTM!`. A finding may cite a rule with a `quote` from a repository file; Bonk checks the text is in that file verbatim and removes it otherwise. Inline comments start with the severity tag (`**[WARNING]** ...`).

Bonk computes the summary's verdict line from the findings instead of trusting the model's: `LGTM!` when there are none, `Review: 3 findings (1 blocking, 2 warnings).` on a first review, and on a re-review `Since last review: N resolved, M still open, K new.`, counting earlier findings confirmed fixed during the run (threads Bonk resolved, and threads the author resolved that the model confirmed fixed; a thread Bonk already followed up on is not confirmed twice), earlier findings re-reported, and new findings.

A review run must actually produce a review. When the run was a review request (a `pull_request` event, or a request that mentions "review") and OpenCode exits without writing the findings file and without a verdict line, Bonk deletes that attempt's comment and retries within the `timeout`/`retries` budget. If no attempt produces a review, the run fails and the previous summary is left untouched. Failed runs log a best-effort cause (`timeout`, `content_filter`, `provider_errors`, `permission_blocked`, or `incomplete_review`), which the finalize step repeats.

On re-reviews Bonk also follows up on its own inline threads. Each thread in `<bonk_previous_review>` carries its id, and the model adds `thread_actions` to the findings file:

- a fixed finding gets a short reply (`Fixed in <sha>: ...`) and its thread is resolved;
- a finding the author or a maintainer declined with a reason gets a one-line acknowledgement and is resolved, unless it is a blocking correctness or security defect;
- a question or pushback gets a reply;
- a thread a person resolved is reopened only if the exact defect is still present.

Bonk runs these actions itself and only on threads it started; actions on anyone else's thread are ignored. A finding that re-reports an earlier one carries that thread's id, and Bonk keeps the existing thread instead of posting it again; if that thread was resolved, the finding is listed in the summary under "Earlier findings still present". A finding without an id is new and is posted, even right next to an earlier thread. (The only other match is a verbatim copy on the same line of the same file.) No finding is ever dropped. An open Bonk thread that no finding references is resolved, but only if nobody replied to it and its file changed since the last review, since untouched code cannot have been fixed. Comments and threads are read page by page, with each thread's first comment and newest replies, so busy pull requests work too.

A run counts as a review when OpenCode wrote the findings file, when it was triggered by a `pull_request` event, when Bonk submitted a pull request review during the run, or when the response starts with one of those verdict lines (`LGTM` without the bang is also accepted). Other responses, such as `/bonk explain ...`, stay normal comments and leave the last reviewed head unchanged. Before the first marker exists, Bonk uses the commit of its latest inline review.

Bonk recognizes its own comments, reviews, and markers by the GitHub App behind its installation token (GraphQL `viewer`), so self-hosted Apps need no extra configuration.

GitHub only lets App tokens with `contents: write` resolve or reopen review threads. When `token_permissions` withholds that (for example `NO_PUSH`), Bonk requests a second installation token with `contents`, `issues`, and `pull_requests` write for the publish step only. That step runs Bonk's own code after OpenCode has exited; OpenCode never sees the token, so it still cannot push. Fork pull requests do not get the second token, so Bonk replies on threads but cannot resolve them there.

When a pull request's base branch is not the repository's default branch, the prompt marks it as part of a stack (`base_branch`, `stacked_pull_request`, and the open pull request for that base branch, when there is one). Reviews then treat what the base branch introduces as existing code, and a limitation the stack says a follow-up handles is at most `info`. The base branch is known on `pull_request` events, and on other events with `rereview_context` enabled.

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
| `ignore_paths`       | Paths to leave out of reviews (see [Re-reviews](#re-reviews))                    | No       |
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
