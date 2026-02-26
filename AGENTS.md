# AGENTS.md

GitHub code review bot built on Cloudflare Workers + Hono + TypeScript. Use `bun` exclusively.

## Commands

```bash
bun install              # Install dependencies
bun run test             # Run all tests (vitest in Workers pool)
bun run test -- src/events  # Run single test file by name
bun run tsc --noEmit     # Type check
bun run deploy           # Deploy to Cloudflare (wrangler)
bun run dev              # Local development server
bun run cli              # Run CLI tool
bun run lint             # Lint with oxlint
bun run format           # Format with oxfmt
```

When modifying `package.json`, always run `bun install` and commit both `package.json` and `bun.lock` together. CI uses `bun install --frozen-lockfile`.

## Rules

### Always

- Run `bun run tsc --noEmit` and `bun run test` before considering work complete.
- Use structured logging via `src/log.ts`. Never use raw `console.log/info/error`.
- Use `Result` types from `better-result` for error handling at API boundaries. Use `TaggedError` subclasses from `src/errors.ts` for domain errors.
- Use `errorWithException()` for error logging -- it sanitizes secrets automatically.
- Use `type` imports for type-only imports: `import type { Env } from './types'`.
- Group imports: external packages first, then local modules.
- Always provide a typed catch mapper when using `Result.tryPromise`. Untyped exceptions lose error context and make debugging harder.

### Never

- Never log tokens, API keys, or credentials. Git error messages may contain URL tokens -- always use `errorWithException()`.
- Never add new dependencies without justification. This is a small, focused project.
- Never use Node.js-specific APIs that are unavailable in Cloudflare Workers (no `fs`, no `path`, no `child_process`).
- Never write tests that mock everything -- tests must exercise real code paths. See [Testing](#testing).
- Never use raw `console.log/info/error` -- use the structured logger.

## Architecture

**Cloudflare Workers** application (not Node.js). Key constraints:

- No filesystem access (env vars via `process.env` with `nodejs_compat`)
- Use Workers-compatible APIs (Fetch, Web Crypto, etc.)
- Durable Objects for stateful coordination

### Operation Modes

**`/webhooks` - GitHub Actions Mode**: Webhook events trigger GitHub Actions workflows via the composite action in `github/`. OpenCode runs inside the workflow, not in Bonk's infrastructure. The `RepoAgent` Durable Object tracks run status and posts failure comments.

**`/ask` - Direct Sandbox Mode**: Runs OpenCode directly in Cloudflare Sandbox for programmatic API access. Requires bearer auth (`ASK_SECRET`). Returns SSE stream.

### Project Structure

```
src/                     # Cloudflare Workers application
  index.ts               # Hono app entry, all route definitions, webhook handling
  github.ts              # GitHub API (Octokit with retry/throttling, GraphQL for context)
  sandbox.ts             # Cloudflare Sandbox + OpenCode SDK integration
  agent.ts               # RepoAgent Durable Object (workflow run tracking, failure comments)
  events.ts              # Webhook event parsing and response formatting
  oidc.ts                # OIDC token validation, GitHub token exchange, cross-repo security
  workflow.ts            # GitHub Actions workflow file management (creates PRs)
  images.ts              # Image/file extraction from GitHub comment markdown (20MB limit)
  metrics.ts             # Cloudflare Analytics Engine metrics + stats queries
  errors.ts              # Domain error types (TaggedError subclasses)
  constants.ts           # Shared configuration constants (retry, polling, limits)
  types.ts               # All shared type definitions (Env, request/response, GitHub types)
  log.ts                 # Structured JSON logging (context propagation, secret sanitization)
  hbs.d.ts               # TypeScript declarations for build-time constants + asset imports

github/                  # GitHub Actions composite action
  action.yml             # Composite action (mentions check, orchestration, opencode run, finalize)
  fork_guidance.md       # Template for fork PR comment-only mode instructions
  script/
    orchestrate.ts       # Pre-flight: permissions, setup, version, prompt, OIDC exchange, fork handling, tracking
    finalize.ts          # Post-run: report status back to API (always runs, never fails the workflow)
    context.ts           # Context helpers, custom @actions/core replacement, fork detection
    http.ts              # HTTP utilities (fetchWithTimeout, fetchWithRetry with backoff)
    publish              # Shell script for publishing the action

cli/                     # Interactive CLI tool (bun run cli)
  index.ts               # Install + workflow commands using @clack/prompts
  github.ts              # GitHub API helpers using gh CLI
  templates/             # Handlebars workflow templates (bonk, scheduled, triage, review, custom)

test/                    # Tests (vitest in @cloudflare/vitest-pool-workers)
  index.spec.ts          # All tests (event parsing, prompt extraction, OIDC, logging)
  fixtures/              # Realistic webhook payload fixtures

ae_queries/              # SQL queries for /stats Analytics Engine endpoints
```

## OIDC and Authentication

OIDC is the most security-critical path. All `/api/github/*` endpoints are protected by OIDC token validation.

### Endpoint Protection Pattern

Every authenticated endpoint follows this sequence:

```
extractBearerToken() -> validateOIDCAndExtractRepo() -> compare claims.owner/repo with body.owner/repo -> proceed
```

When adding new authenticated endpoints, follow this exact pattern. The claims-vs-body comparison prevents a valid token from one repo being used to act on another.

### Token Exchange Endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /auth/get_github_app_installation` | None | Look up installation ID for a repo (public lookup) |
| `POST /auth/exchange_github_app_token` | OIDC | Same-repo: OIDC token -> App installation token |
| `POST /auth/exchange_github_app_token_for_repo` | OIDC | Cross-repo: 3 security checks (same-org, visibility, actor write access) |
| `POST /auth/exchange_github_app_token_with_pat` | OIDC | PAT-based exchange, **disabled by default** (`ENABLE_PAT_EXCHANGE` env var) |

### Cross-Repo Security Model

`handleExchangeTokenForRepo()` enforces three layered checks before issuing a token for a different repo:

1. **Same-org check**: requesting and target repos must be in the same GitHub org
2. **Visibility check**: a public repo cannot request a token for a private repo
3. **Actor write access**: the workflow actor must have write access to the target repo

Each check has structured audit logging. Follow this pattern for any future cross-repo features.

### Installation Cache with Stale Retry

`createOctokitForRepo()` handles app reinstallation: if a cached installation ID returns 404, it deletes the cache entry and retries with a fresh API lookup. This prevents permanent failures after an app is reinstalled.

## GitHub Actions Composite Action

The composite action in `github/action.yml` is the primary entry point for the webhook-driven flow.

### Step Chain and Conditions

Each step gates on the previous steps' outputs. The condition chain is:

```
mentions.skip != true  AND  preflight.skip != true  [AND additional per-step conditions]
```

| Step | Condition | Key Behavior |
|------|-----------|--------------|
| 1. Check mentions | always | Matches comment body against trigger phrases; short-circuits workflow on miss |
| 2. Setup bun | mentions passed | Installs bun 1.3 |
| 3. Pre-flight orchestration | mentions passed | Single `bun run orchestrate.ts` consolidating 7 formerly separate steps |
| 4. Install opencode | preflight passed | `bun install -g opencode-ai@latest` |
| 5. Configure Git | preflight passed | Sets bot identity, **replaces git credential with App token** |
| 6. Run opencode | preflight passed + fork check | `timeout 45m` with `set +e` to capture exit code |
| 7. Finalize | `if: always()` when preflight passed | Reports status; **never calls `setFailed()`** |

### Git Credential Replacement (Critical)

`actions/checkout` persists `GITHUB_TOKEN` in the local git config via `http.https://github.com/.extraheader`. Pushes made with `GITHUB_TOKEN` do not trigger downstream workflows (GitHub's infinite-loop prevention). The "Configure Git" step replaces this credential with the App installation token obtained via OIDC exchange, so Bonk's pushes trigger CI.

```bash
if [ -n "${GH_TOKEN}" ]; then
  git config --unset-all "http.${GITHUB_SERVER_URL}/.extraheader" 2>/dev/null || true
  git remote set-url origin "https://x-access-token:${GH_TOKEN}@${host}/${GITHUB_REPOSITORY}.git"
fi
```

### Env Var Flow Between Steps

Outputs and env vars are scoped to individual steps. The orchestrator writes outputs via `core.setOutput()` and env vars via `appendToGithubEnv()`. Key variables:

- `GH_TOKEN` (GITHUB_ENV): App installation token from OIDC exchange
- `PROMPT` / `value` output: assembled prompt from orchestrator
- `PR_NUMBER`, `ISSUE_NUMBER` (env): passed to both opencode and finalize steps
- `OPENCODE_STATUS` (env in finalize): the outcome of the opencode step

Multiline values in `GITHUB_ENV` and step outputs use random delimiters (`BONK_<uuid>`) to prevent injection attacks.

### Action Script Conventions

- Scripts in `github/script/` use **bun** (not Node.js) to run TypeScript directly -- no build/bundle step.
- Scripts use a custom `core` implementation from `context.ts` instead of `@actions/core`. This avoids an unnecessary dependency while providing `info`, `warning`, `error`, `setFailed`, and `setOutput`.
- `core.setFailed()` calls `process.exit(1)` and is typed as `never`. Any `setFailed()` call is a hard stop of the entire orchestrator.
- `finalize.ts` intentionally never calls `setFailed()` -- it uses `core.warning()` only, so it never masks the actual workflow failure.

### Fork Handling

Fork PRs use an OIDC-first approach:

1. Always attempt OIDC exchange (never skip based on assumptions)
2. If OIDC succeeds: run OpenCode in **comment-only mode** with fork guidance prompt
3. If OIDC fails: post a "not supported on forks" comment (if `forks: true` input)
4. Fork runs are not tracked via `/api/github/track` (no finalization needed)

Fork comment deduplication: checks for `FORK_COMMENT_MARKER` HTML comment before posting.

## Durable Object: RepoAgent

`RepoAgent` (`src/agent.ts`) tracks workflow runs per repo and posts failure comments. ID format: `{owner}/{repo}`.

### State Schema

```typescript
interface RepoAgentState {
  installationId: number;
  installationSource?: "cache" | "api";
  owner?: string;                                        // Persisted for alarm wakeups
  repo?: string;                                         // Persisted for alarm wakeups
  activeRuns: Record<number, CheckStatusPayload>;        // runId -> payload
  recentlyFinalizedRuns?: Record<number, number>;        // runId -> timestamp (1hr TTL)
  failureComments?: Record<string, FailureCommentRef>;   // contextKey -> ref (7-day TTL)
}
```

Context keys: `"i:{issueNumber}"` for top-level comments, `"rc:{reviewCommentId}"` for review thread replies.

### Three Finalization Paths

| Path | Trigger | When it fires | Posts comments? |
|------|---------|---------------|-----------------|
| **Action-driven** | `finalize.ts` -> `PUT /api/github/track` -> `agent.finalizeRun()` | Normal completion | Yes, for failures |
| **Polling** | DO alarm -> `agent.checkWorkflowStatus()` every 5 min | Finalize call never arrived (network failure) | Yes, including timeout |
| **Webhook** | `workflow_run.completed` -> `agent.handleWorkflowRunCompleted()` | Both above failed | **Only for tracked runs**; untracked runs get metrics only |

The webhook safety net intentionally does NOT post comments for untracked runs. Doing so caused failure comment spam (issue #114) because concurrency-cancelled re-triggers, workflow variants, and self-triggered runs are all untracked.

### `this.name` Workaround (workerd #2240)

When a DO wakes from hibernation for an alarm, `this.name` throws because the `agents` package only sets the name during `fetch()`. Owner and repo are persisted to state on the first RPC call so alarm-woken DOs can identify themselves. The `owner`/`repo` getters read from state first, falling back to `this.name` with a try/catch.

### Failure Comment Edit-in-Place

`postFailureComment()` uses a 3-priority edit strategy to prevent duplicate comments:

1. Edit the "waiting for approval" comment (from polling) if it exists
2. Edit a prior failure comment for the same context key
3. Create a new comment and store its ref in state for future edits
4. If an edit 404s (comment was deleted), fall back to creating a new one

Comments are either top-level issue/PR comments or review thread replies, depending on the trigger type.

### DO Scheduling

All `this.schedule()` calls must be wrapped in try/catch. Scheduling failures are non-fatal because the `workflow_run` webhook acts as a secondary safety net.

## Error Handling

Use `Result` types from `better-result` instead of thrown exceptions at API boundaries:

```typescript
import { Result, Ok, Err } from "better-result";
import { ValidationError, GitHubAPIError } from "./errors";

function doThing(): Result<Data, ValidationError | GitHubAPIError> {
  if (!valid) return Err(new ValidationError("bad input"));
  return Ok(data);
}
```

### `Result.tryPromise` Catch Mappers

Always provide a typed catch mapper to `Result.tryPromise`. This converts untyped exceptions into domain errors:

```typescript
// Good: typed catch mapper with retry
const result = await Result.tryPromise(
  {
    try: () => octokit.rest.repos.get({ owner, repo }),
    catch: (e) => new GitHubAPIError({ operation: "get_repo", cause: e }),
  },
  { retry: RETRY_CONFIG },
);

// Good: typed catch mapper without retry
const result = await Result.tryPromise({
  try: () => validateToken(jwt),
  catch: (e) => new OIDCValidationError({ message: "invalid token", cause: e }),
});

// Bad: no catch mapper -- error type is `unknown`
const result = await Result.tryPromise({ try: () => fetch(url) });
```

### Domain Error Types

All domain errors are `TaggedError` subclasses in `src/errors.ts`. Use `.is()` for pattern matching:

| Error | Use Case |
|-------|----------|
| `OIDCValidationError` | JWT validation failures |
| `AuthorizationError` | 6 reason variants: `missing_header`, `invalid_format`, `invalid_token`, `cross_org`, `visibility`, `no_write_access` |
| `InstallationNotFoundError` | App not installed for owner/repo |
| `ValidationError` | Input validation with optional `field` |
| `NotFoundError` | Resource not found with `resource` and `id` |
| `GitHubAPIError` | Wraps API exceptions with `operation` and optional `statusCode` |
| `SandboxError` | Wraps sandbox failures with `operation` |

Union types: `AuthError = OIDCValidationError | AuthorizationError`, `TokenExchangeError = AuthError | InstallationNotFoundError | GitHubAPIError`.

### Request Handler Errors

- Return `{ error: string }` JSON with appropriate HTTP status codes.
- `PUT /api/github/track` (finalize) **always returns 200**, even on error (includes a `warning` field). This is deliberate -- the finalize step runs with `if: always()` and shouldn't mask the actual failure.

### Retry Boundaries

`RETRY_CONFIG` in `src/constants.ts` retries on 5xx and network errors with exponential backoff. Client errors (4xx) are never retried -- they won't succeed on retry.

## Logging

Use structured JSON logging via `src/log.ts`.

```typescript
import { createLogger, log } from "./log";

// Create logger with context (preferred for request handlers)
const requestLog = createLogger({ request_id: ulid(), owner, repo, issue_number });
requestLog.info("webhook_completed", { event_type: "issue_comment", duration_ms: 42 });

// Child loggers inherit context
const sessionLog = requestLog.child({ session_id: "abc123" });

// Error logging -- sanitizes secrets automatically
requestLog.errorWithException("operation_failed", error, { additional: "context" });
```

- **Event names**: `snake_case`, past tense for completed actions. Prefix with domain when helpful: `sandbox_clone_failed`, `github_rate_limited`.
- **Required context**: `request_id` (ULID), `owner`, `repo`. Include `issue_number`, `run_id`, `actor`, `duration_ms` when relevant.

## Code Style

### Formatting (enforced by .editorconfig + oxfmt)

- 2 spaces, LF line endings, double quotes, semicolons required, final newline required.

### Naming

- `camelCase` for functions/variables
- `PascalCase` for types/classes/interfaces
- `snake_case` for log event names and log field names
- Prefix interfaces with descriptive nouns (e.g., `EventContext`, `TrackWorkflowRequest`)

### Types

- Strict mode enabled. Define shared types in `src/types.ts`.
- Use explicit return types for exported functions.
- Target: ES2024, module resolution: Bundler.

### Code Organization

- Keep related code together. Do not split across too many files or over-abstract.
- External API functions stay in their respective files (`github.ts`, `sandbox.ts`, `oidc.ts`).
- Comments explain "why", not "what". Skip comments for short (<10 line) functions.
- Prioritize comments for I/O boundaries, external system orchestration, and stateful code.

## Testing

Tests run in `@cloudflare/vitest-pool-workers` (Workers environment). Config: `vitest.config.mts`, `test/tsconfig.json`.

Tests must verify actual implementation behavior, not document expected structures.

### Write tests that

- Call actual functions and verify return values
- Test input parsing, validation, and error handling with real payloads
- Verify API contract boundaries (request/response formats)
- Test edge cases and failure modes
- Use fixtures from `test/fixtures/` for realistic payloads

### Do NOT write tests that

- Create local objects and verify their own structure
- Use string equality checks with hardcoded values unrelated to implementation
- Stub/mock everything such that no real code paths are tested
- Exist purely as documentation

Bias towards fewer, focused integration tests. More tests are not better.

## Conventions

### Configuration

- Prefer JSONC for config files (see `wrangler.jsonc`, `wrangler.test.jsonc`).
- Build-time constants (`__VERSION__`, `__COMMIT__`) are injected via wrangler `--define`.
- Handlebars templates (`*.hbs`) and SQL files (`*.sql`) are imported as strings via wrangler `rules`.

### API Patterns

- Hono routes grouped by feature (auth, api/github, ask, webhooks).
- OIDC validation before processing API requests from GitHub Actions.
- Bearer auth for protected endpoints (`ASK_SECRET`).
- Return `{ error: string }` for errors, `{ ok: true }` for success.

### GitHub Integration

- Use `createOctokit()` with installation ID for authenticated requests.
- `ResilientOctokit` includes retry and throttling plugins.
- GraphQL for fetching issue/PR context (avoids multiple REST calls). REST for mutations.
- Installation IDs are cached in KV (`APP_INSTALLATIONS`) with 30-minute TTL.

### Durable Objects

- `RepoAgent`: Tracks workflow runs per repo, posts failure comments. ID format: `{owner}/{repo}`.
- Three finalization paths: action-driven (finalize.ts), polling (alarm), `workflow_run` webhook (safety net).
- Uses `agents` package for simplified DO management.
- See [Durable Object: RepoAgent](#durable-object-repoagent) for state schema and implementation details.

### Releases

- Ignore changes to `.github/` directories when writing release notes -- those are internal workflow configs, not user-facing.

## Known Pitfalls

Lessons from past incidents. Keep these in mind when modifying related code.

### Git Pushes Must Use the App Token

`actions/checkout` sets `GITHUB_TOKEN` in git's `http.extraheader`. Pushes with this token don't trigger downstream workflows. The "Configure Git" step replaces the credential with the App token from OIDC. If you change checkout or git configuration steps, verify pushes still trigger CI. (Issue #112)

### Env Vars Are Step-Scoped in Composite Actions

Env vars set in one composite action step are NOT available in subsequent steps unless written to `GITHUB_ENV`. Outputs set via `core.setOutput()` are accessed as `steps.<id>.outputs.<name>`. Forgetting to bridge a variable (like `PR_NUMBER`) causes silent failures where the model operates on the wrong context. (Issues #116, #117)

### Untracked Workflow Runs Must Not Get Comments

The `workflow_run.completed` webhook fires for all workflow runs, including concurrency-cancelled re-triggers, workflow variants (bonk-review.yml), and self-triggered runs. Posting failure comments for untracked runs causes spam. Only tracked runs (registered via `POST /api/github/track`) should receive comments. (Issue #114)

### DO Alarm Wakeups Don't Set `this.name`

The `agents` package only sets `this.name` during `fetch()`. Alarm callbacks run without a fetch context, so `this.name` throws. Persist any identity data to state and read from state first. (Issue #101, workerd #2240)

### Finalize Must Never Fail the Workflow

`finalize.ts` runs with `if: always()` to report status. If it calls `core.setFailed()`, it masks the actual workflow failure in the GitHub Actions UI. Use `core.warning()` only.

### The `skipped` Status Means Upstream Failure

When GitHub Actions skips a step because a prior step failed, the outcome is `skipped`, not `failure`. `finalize.ts` explicitly remaps `skipped` -> `failure` client-side, and `agent.ts` treats any non-`success` status as a failure (defense-in-depth). Don't remove either check.
