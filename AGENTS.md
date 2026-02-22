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
  oidc.ts                # OIDC token validation and GitHub token exchange
  workflow.ts            # GitHub Actions workflow file management (creates PRs)
  images.ts              # Image/file extraction from GitHub comment markdown
  metrics.ts             # Cloudflare Analytics Engine metrics + stats queries
  errors.ts              # Domain error types (TaggedError subclasses)
  constants.ts           # Shared configuration constants (retry, polling, limits)
  types.ts               # All shared type definitions (Env, request/response, GitHub types)
  log.ts                 # Structured JSON logging (context propagation, secret sanitization)
  hbs.d.ts               # TypeScript declarations for build-time constants + asset imports

github/                  # GitHub Actions composite action
  action.yml             # Action definition (mention check, orchestration, opencode run, finalize)
  script/orchestrate.ts  # Pre-flight: permissions, setup, version, prompt building, OIDC exchange
  script/finalize.ts     # Post-run: report status back to API (always runs)
  script/context.ts      # Context helpers for action scripts (env parsing, fork detection)
  script/http.ts         # HTTP utilities (fetchWithTimeout, fetchWithRetry)
  fork_guidance.md       # Template for fork PR comment-only mode instructions

cli/                     # Interactive CLI tool (bun run cli)
  index.ts               # Install + workflow commands using @clack/prompts
  github.ts              # GitHub API helpers using gh CLI
  templates/             # Handlebars workflow templates (bonk, scheduled, triage, review, custom)

test/                    # Tests (vitest in @cloudflare/vitest-pool-workers)
  index.spec.ts          # All tests (event parsing, prompt extraction, OIDC, logging)
  fixtures/              # Realistic webhook payload fixtures

ae_queries/              # SQL queries for /stats Analytics Engine endpoints
```

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

All domain errors are `TaggedError` subclasses defined in `src/errors.ts`: `OIDCValidationError`, `AuthorizationError`, `InstallationNotFoundError`, `ValidationError`, `NotFoundError`, `GitHubAPIError`, `SandboxError`. Use `.is()` for pattern matching.

For request handlers, return JSON errors with appropriate HTTP status codes (`{ error: string }`).

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

### Releases

- Ignore changes to `.github/` directories when writing release notes -- those are internal workflow configs, not user-facing.
