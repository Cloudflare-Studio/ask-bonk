# Flue Upgrade Plan

Last reviewed: 2026-07-07.

Bonk is already on the latest published Flue packages available on npm as of this review:

- `@flue/runtime@1.0.0-beta.9`
- `@flue/cli@1.0.0-beta.9`
- `@flue/github@1.0.0-beta.1`

The current upstream `main` changelog contains unreleased breaking changes beyond beta.9. Treat those as the target for the next Flue upgrade once they are published.

## Current Bonk Usage

- `src/app.ts` mounts `flue()` and keeps OIDC-protected `/api/github/*` compatibility routes.
- `src/workflows/github-setup.ts`, `src/workflows/github-track.ts`, and `src/workflows/github-finalize.ts` define internal workflows around `defineWorkflow({ agent, input, output, run })`.
- `src/internal-workflows.ts` defines the internal workflow agent and route guard, then bridges workflow execution back to Worker bindings through the Flue agent initializer context.
- `src/channels/github.ts` uses `createGitHubChannel()` with provider-native `{ c, delivery }` webhook deliveries, and preserves the generated `/channels/github/webhook` route while `src/app.ts` keeps legacy `/webhooks` compatibility.
- `src/agent.ts` still owns GitHub Actions run state through `RepoAgent`. Keep this until Bonk runs OpenCode inside a Flue-managed sandbox and can use Flue workflow or agent state as the primary execution record.

## Upgrade Steps

1. Upgrade the published Flue packages together.

   Run `bun update @flue/runtime @flue/cli @flue/github` once a newer Flue release is published. If `package.json` ranges need to change, run `bun install` and commit `bun.lock` with `package.json`.

2. Regenerate and verify Cloudflare output.

   Flue Cloudflare target changes can alter generated Durable Object classes and Worker bindings. Run `bun run build`, `bunx wrangler types`, then commit `worker-configuration.d.ts` if it changes.

3. Verify workflow HTTP semantics before changing the `/api/github/*` bridge.

   Bonk currently calls internal workflows with `POST /workflows/:name?wait=result` and expects `{ result: { status, body } }`. The unreleased changelog removes synchronous result mode for direct agent prompts, not explicitly workflow waits. Confirm the installed Flue docs/types for workflow wait behavior before changing `runInternalWorkflow()` in `src/app.ts` or the tests in `test/github-api-workflows.spec.ts`.

4. If workflow `wait=result` is removed or discouraged, replace the compatibility bridge deliberately.

   Prefer a Flue-supported workflow result read path over bespoke polling. A safe target shape is: admit with `POST /workflows/:name`, keep the internal route header guard, read completion through `client.runs` or the raw `/runs/:runId` APIs if the workflow exposes `runs`, and map the final workflow output back to the existing `/api/github/*` response envelope. Preserve the current external API behavior because GitHub Action scripts depend on synchronous setup, track, and finalize responses.

5. Migrate any dispatch/direct-agent callers to `DeliveredMessage` if Bonk adds them.

   The unreleased Flue API changes `dispatch()` and direct agent HTTP bodies to the unified `DeliveredMessage` shape. Bonk does not currently call `dispatch()` or `client.agents.prompt()`, so this is not an immediate code change. If added later, use `{ kind: "signal", body, attributes }` for GitHub/webhook-style events and keep metadata in flat string `attributes`.

6. Re-check GitHub channel metadata handling after upgrading `@flue/github`.

   The unreleased changelog notes channel examples now preserve sender identity, issue refs, titles, installation IDs, and self-reply-loop metadata as flat `attributes`. Bonk handles provider-native deliveries directly in `handleGitHubDelivery()`, so it should not depend on Flue channel dispatch metadata. Still verify webhook tests for `/channels/github/webhook` and `/webhooks` after upgrading.

7. Keep reset-only persistence changes out of production until migrations are understood.

   The unreleased runtime resets persisted storage schema to v5 for agent submissions. Bonk uses Flue-generated Durable Objects for internal workflows plus `RepoAgent` for production run state. Before deploy, verify whether Flue's reset-only schema affects existing `FlueRegistry`, `FlueControlPlaneAgent`, or workflow Durable Object data, and add a deployment note if clearing Flue-owned state is required.

## Refactor Opportunities

- Replace the `workflowEnvs` map and `Reflect.get(context.harness, "instanceId")` in `src/internal-workflows.ts` with a supported Flue primitive if the new runtime exposes Worker bindings directly to workflow `run()` or Action context. This is the most bespoke Flue-adjacent code in Bonk.
- Use Flue run metadata or public run APIs for internal workflow observability if Bonk needs more visibility into setup/track/finalize failures.
- Reevaluate reducing `RepoAgent` only after OpenCode execution moves from GitHub Actions into a Flue-managed isolated sandbox. Until then, `RepoAgent` remains necessary for external run tracking, alarm polling, and failure-comment edit history.

## Required Validation

For the actual dependency upgrade, run:

- `bun install --frozen-lockfile`
- `bun run tsc --noEmit`
- `bun run test`
- `bun run lint`
- `bun run build`
- `bunx wrangler types --check`
- `bunx wrangler deploy --dry-run --config dist/ask_bonk/wrangler.json --var BONK_VERSION:ci --var BONK_COMMIT:local`
