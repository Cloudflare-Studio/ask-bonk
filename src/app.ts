import { createGitHubChannel, type GitHubWebhookDelivery } from "@flue/github";
import { flue } from "@flue/runtime/routing";
import { getAgentByName } from "agents";
import { Hono, type Context } from "hono";
import { ulid } from "ulid";
import type {
  Env,
  TrackWorkflowRequest,
  FinalizeWorkflowRequest,
  SetupWorkflowRequest,
  WorkflowRunPayload,
} from "./types";
import { deleteInstallation } from "./github";
import { parseWorkflowRunEvent } from "./events";
import type { GitHubActionsJWTClaims } from "./oidc";
import {
  handleGetInstallation,
  handleExchangeToken,
  handleExchangeTokenForRepo,
  handleExchangeTokenWithPAT,
  extractBearerToken,
  validateOIDCAndExtractRepo,
} from "./oidc";
import type { RepoAgent } from "./agent";
import {
  emitMetric,
  queryAnalyticsEngine,
  renderBarChart,
  eventsPerRepoQuery,
  errorsByRepoQuery,
  eventsByActorQuery,
} from "./metrics";
import { log, createLogger, sanitizeSecrets } from "./log";
import { internalWorkflowHeaders } from "./internal-workflows";
import type { WorkflowJobResult } from "./github-workflow-jobs";

const GITHUB_REPO_URL = "https://github.com/ask-bonk/ask-bonk";

function isAllowedOrg(owner: string, env: Env): boolean {
  const allowed: readonly string[] = env.ALLOWED_ORGS ?? [];
  if (allowed.length === 0) return true;
  return allowed.map((o) => o.toLowerCase()).includes(owner.toLowerCase());
}

// Meta events are checked separately for early routing (see isMetaEvent below)
const META_EVENTS = ["installation"] as const;
const SUPPORTED_EVENTS = [
  "issue_comment",
  "pull_request_review_comment",
  "pull_request_review",
  "pull_request",
  "issues",
  "schedule",
  "workflow_dispatch",
  "workflow_run",
  ...META_EVENTS,
] as const;

function getDeliveryRepository(delivery: GitHubWebhookDelivery) {
  return "repository" in delivery.payload ? delivery.payload.repository : undefined;
}

function getDeliveryIssueNumber(delivery: GitHubWebhookDelivery): number | undefined {
  if ("issue" in delivery.payload) return delivery.payload.issue.number;
  if ("pull_request" in delivery.payload) return delivery.payload.pull_request.number;
  return undefined;
}

function isPullRequestDelivery(delivery: GitHubWebhookDelivery): boolean {
  return "pull_request" in delivery.payload;
}

const app = new Hono<{ Bindings: Env }>();
const flueApp = flue() as unknown as Hono<{ Bindings: Env }>;
type GitHubChannelEnv = { Bindings: Env };

app.get("/", (c) => c.redirect(GITHUB_REPO_URL, 302));
app.get("/health", (c) => c.text("OK"));
app.get("/version", (c) =>
  c.json({ version: c.env.BONK_VERSION ?? "dev", commit: c.env.BONK_COMMIT ?? "unknown" }),
);

// Stats endpoints - public dashboards for webhook analytics
const stats = new Hono<{ Bindings: Env }>();

stats.use(async (c, next) => {
  const { CLOUDFLARE_ACCOUNT_ID, ANALYTICS_TOKEN } = c.env;
  if (!CLOUDFLARE_ACCOUNT_ID || !ANALYTICS_TOKEN) {
    return c.json({ error: "Stats endpoint is not configured" }, 500);
  }
  await next();
});

stats.get("/events", async (c) => {
  const result = await queryAnalyticsEngine(c.env, eventsPerRepoQuery);
  if (result.isErr()) {
    log.errorWithException("stats_query_failed", result.error);
    return c.json({ error: "Failed to query stats" }, 500);
  }
  if (c.req.query("format") === "json") return c.json({ data: result.value });
  return c.text(
    renderBarChart(result.value, "Webhook events per repo (last 30d)", "repo", "event_count"),
  );
});

stats.get("/errors", async (c) => {
  const result = await queryAnalyticsEngine(c.env, errorsByRepoQuery);
  if (result.isErr()) {
    log.errorWithException("errors_query_failed", result.error);
    return c.json({ error: "Failed to query errors" }, 500);
  }
  if (c.req.query("format") === "json") return c.json({ data: result.value });
  return c.text(renderBarChart(result.value, "Failures by repo (last 24h)", "repo", "error_count"));
});

stats.get("/actors", async (c) => {
  const result = await queryAnalyticsEngine(c.env, eventsByActorQuery);
  if (result.isErr()) {
    log.errorWithException("stats_query_failed", result.error);
    return c.json({ error: "Failed to query stats" }, 500);
  }
  if (c.req.query("format") === "json") return c.json({ data: result.value });
  return c.text(renderBarChart(result.value, "Mentions per actor (last 7d)", "actor", "event_count"));
});

app.route("/stats", stats);

// Legacy GitHub App webhook URL. Keep this as an alias so existing app
// configuration continues to work while Flue owns the canonical channel route.
app.post("/webhooks", async (c) => handleLegacyWebhook(c));

// OIDC endpoints for OpenCode GitHub Action token exchange
const auth = new Hono<{ Bindings: Env }>();

auth.get("/get_github_app_installation", async (c) => {
  const owner = c.req.query("owner");
  const repo = c.req.query("repo");

  if (!owner || !repo) {
    return c.json({ error: "Missing owner or repo parameter" }, 400);
  }

  const result = await handleGetInstallation(c.env, owner, repo);
  return c.json(result);
});

auth.post("/exchange_github_app_token", async (c) => {
  const authHeader = c.req.header("Authorization") ?? null;

  // Body is optional — callers may include { permissions } to scope the token.
  // Accepts a preset name ("NO_PUSH", "WRITE") or a custom permissions object.
  let body: { permissions?: import("./oidc").TokenPermissionsInput } = {};
  try {
    body = await c.req.json();
  } catch {
    // Empty body or non-JSON is fine — use defaults
  }

  const result = await handleExchangeToken(c.env, authHeader, body);

  if (result.isErr()) {
    return c.json({ error: result.error.message }, 401);
  }
  return c.json(result.value);
});

auth.post("/exchange_github_app_token_for_repo", async (c) => {
  const authHeader = c.req.header("Authorization");
  let body: { owner?: string; repo?: string } = {};

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const result = await handleExchangeTokenForRepo(c.env, authHeader ?? null, body);
  if (result.isErr()) {
    return c.json({ error: result.error.message }, 401);
  }
  return c.json(result.value);
});

auth.post("/exchange_github_app_token_with_pat", async (c) => {
  const authHeader = c.req.header("Authorization");
  let body: { owner?: string; repo?: string } = {};

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const result = await handleExchangeTokenWithPAT(c.env, authHeader ?? null, body);
  if (result.isErr()) {
    return c.json({ error: result.error.message }, 401);
  }
  return c.json(result.value);
});

app.route("/auth", auth);

// GitHub API endpoints - called by the GitHub Action for tracking.
// All routes are OIDC-protected: the middleware validates the token and stores
// the verified claims on the context. Handlers compare claims.owner/repo with
// the request body to prevent cross-repo token reuse.
type OIDCVars = { oidc: { claims: GitHubActionsJWTClaims; owner: string; repo: string } };
const apiGithub = new Hono<{ Bindings: Env; Variables: OIDCVars }>();

apiGithub.use(async (c, next) => {
  const oidcToken = extractBearerToken(c.req.header("Authorization"));
  if (!oidcToken) return c.json({ error: "Missing or invalid Authorization header" }, 401);

  const result = await validateOIDCAndExtractRepo(oidcToken);
  if (result.isErr()) return c.json({ error: result.error.message }, 401);

  c.set("oidc", result.value);
  await next();
});

// Returns a 403 Response if the OIDC claims don't match the body's owner/repo,
// or null if the match passes.
function requireRepoMatch(
  oidc: OIDCVars["oidc"],
  bodyOwner: string,
  bodyRepo: string,
): { error: string; status: 403 } | null {
  if (oidc.owner !== bodyOwner || oidc.repo !== bodyRepo) {
    return {
      error: `OIDC token is for ${oidc.owner}/${oidc.repo}, not ${bodyOwner}/${bodyRepo}`,
      status: 403,
    };
  }
  return null;
}

async function runInternalWorkflow<TBody>(
  requestUrl: string,
  env: Env,
  name: string,
  payload: unknown,
): Promise<WorkflowJobResult<TBody>> {
  const url = new URL(requestUrl);
  url.pathname = `/workflows/${name}`;
  url.search = "?wait=result";

  const response = await flueApp.fetch(
    new Request(url, {
      method: "POST",
      headers: internalWorkflowHeaders(),
      body: JSON.stringify(payload),
    }),
    env,
  );

  if (!response.ok) {
    const message = sanitizeSecrets(await response.text());
    return { status: 500, body: { error: message } as TBody };
  }

  const envelope = (await response.json()) as { result?: WorkflowJobResult<TBody> };
  if (!envelope.result) {
    return {
      status: 500,
      body: { error: "Workflow completed without a result" } as TBody,
    };
  }
  return envelope.result;
}

// POST /api/github/setup - Check if workflow file exists, create PR if not
apiGithub.post("/setup", async (c) => {
  let body: SetupWorkflowRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.owner || !body.repo || !body.issue_number || !body.default_branch) {
    return c.json(
      {
        error: "Missing required fields: owner, repo, issue_number, default_branch",
      },
      400,
    );
  }

  const mismatch = requireRepoMatch(c.get("oidc"), body.owner, body.repo);
  if (mismatch) return c.json({ error: mismatch.error }, mismatch.status);

  const result = await runInternalWorkflow(c.req.url, c.env, "github-setup", body);
  return c.json(result.body, result.status);
});

// POST /api/github/track - Start tracking a workflow run
apiGithub.post("/track", async (c) => {
  let body: TrackWorkflowRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (
    !body.owner ||
    !body.repo ||
    !body.run_id ||
    !body.run_url ||
    !body.issue_number ||
    !body.created_at
  ) {
    return c.json(
      {
        error: "Missing required fields: owner, repo, run_id, run_url, issue_number, created_at",
      },
      400,
    );
  }

  const mismatch = requireRepoMatch(c.get("oidc"), body.owner, body.repo);
  if (mismatch) return c.json({ error: mismatch.error }, mismatch.status);

  const actor = c.get("oidc").claims.actor;
  const result = await runInternalWorkflow(c.req.url, c.env, "github-track", { ...body, actor });
  return c.json(result.body, result.status);
});

// PUT /api/github/track - Finalize tracking a workflow run
apiGithub.put("/track", async (c) => {
  let body: FinalizeWorkflowRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.owner || !body.repo || !body.run_id || !body.status) {
    return c.json({ error: "Missing required fields: owner, repo, run_id, status" }, 400);
  }

  const mismatch = requireRepoMatch(c.get("oidc"), body.owner, body.repo);
  if (mismatch) return c.json({ error: mismatch.error }, mismatch.status);

  const actor = c.get("oidc").claims.actor;
  const result = await runInternalWorkflow(c.req.url, c.env, "github-finalize", { ...body, actor });
  return c.json(result.body, result.status);
});

app.route("/api/github", apiGithub);
// Flue ships its own Hono dependency; the runtime route is structurally compatible at runtime.
app.route("/", flueApp);

export default app;

async function handleLegacyWebhook(c: Context<GitHubChannelEnv>): Promise<Response> {
  const channel = createGitHubChannel<GitHubChannelEnv>({
    webhookSecret: c.env.GITHUB_WEBHOOK_SECRET,
    webhook: ({ delivery }) => handleGitHubDelivery(delivery, c.env),
  });
  const webhookRoute = channel.routes[0];
  if (!webhookRoute) return new Response("GitHub webhook route is unavailable", { status: 500 });
  return webhookRoute.handler(c, async () => undefined);
}

export async function handleGitHubDelivery(
  event: GitHubWebhookDelivery,
  env: Env,
): Promise<Response> {
  const startTime = Date.now();
  const requestId = ulid();

  // Installation ID caching is handled by getInstallationId() in oidc.ts on cache miss.
  // This avoids redundant KV writes on every webhook (see issue #52).
  const repository = getDeliveryRepository(event);
  const owner = repository?.owner.login;
  const repoName = repository?.name;
  const repoKey = owner && repoName ? `${owner}/${repoName}` : "unknown/unknown";
  const sender = "sender" in event.payload ? event.payload.sender?.login : undefined;
  const issueNumber = getDeliveryIssueNumber(event);
  const isPrivate = repository?.private;
  const isPullRequest = isPullRequestDelivery(event);

  const webhookLog = createLogger({
    request_id: requestId,
    owner: owner ?? "unknown",
    repo: repoName ?? "unknown",
    issue_number: issueNumber,
    actor: sender,
  });

  try {
    // Handle meta events (installation) before other checks - these may delete installations
    const isMetaEvent = META_EVENTS.includes(event.name as (typeof META_EVENTS)[number]);
    if (isMetaEvent) {
      await handleMetaEvent(event.name, event.payload, env);
      webhookLog.info("webhook_completed", {
        event_type: event.name,
        delivery_id: event.deliveryId,
        hook_id: event.hookId,
        installation_target: event.installationTarget,
        is_private: isPrivate,
        is_pull_request: isPullRequest,
        duration_ms: Date.now() - startTime,
      });
      emitMetric(env, {
        repo: repoKey,
        eventType: "installation",
        eventSubtype: event.name,
        status: "success",
        actor: sender,
      });
      return new Response("OK", { status: 200 });
    }

    // Check if the repo owner is in the allowed list
    if (owner && !isAllowedOrg(owner, env)) {
      webhookLog.info("webhook_skipped_not_allowed", {
        event_type: event.name,
        delivery_id: event.deliveryId,
        duration_ms: Date.now() - startTime,
      });
      emitMetric(env, {
        repo: repoKey,
        eventType: "webhook",
        eventSubtype: event.name,
        status: "skipped",
        actor: sender,
      });
      return new Response("OK", { status: 200 });
    }

    if (!SUPPORTED_EVENTS.includes(event.name as (typeof SUPPORTED_EVENTS)[number])) {
      webhookLog.info("webhook_unsupported_event", {
        event_type: event.name,
        delivery_id: event.deliveryId,
        duration_ms: Date.now() - startTime,
      });
      return new Response("OK", { status: 200 });
    }

    // Route to handlers that do real work; everything else is log-only
    // (tracking is handled by the GitHub Action calling /api/github/track).
    if (event.name === "workflow_run") {
      await handleWorkflowRunEvent(event.payload, env);
    }

    webhookLog.info("webhook_completed", {
      event_type: event.name,
      delivery_id: event.deliveryId,
      hook_id: event.hookId,
      installation_target: event.installationTarget,
      is_private: isPrivate,
      is_pull_request: isPullRequest,
      duration_ms: Date.now() - startTime,
    });
    emitMetric(env, {
      repo: repoKey,
      eventType: "webhook",
      eventSubtype: event.name,
      status: "success",
      actor: sender,
      issueNumber,
      isPrivate,
      isPullRequest,
    });
    return new Response("OK", { status: 200 });
  } catch (error) {
    webhookLog.errorWithException("webhook_error", error, {
      event_type: event.name,
      delivery_id: event.deliveryId,
      duration_ms: Date.now() - startTime,
    });
    emitMetric(env, {
      repo: repoKey,
      eventType: "webhook",
      eventSubtype: event.name,
      status: "error",
      actor: sender,
      errorCode: error instanceof Error ? sanitizeSecrets(error.message).slice(0, 100) : "unknown",
      issueNumber,
      isPrivate,
      isPullRequest,
    });
    return new Response("Internal error", { status: 500 });
  }
}

// Meta events: GitHub App lifecycle events (installation)
// Handles GitHub App installation lifecycle events (created, deleted)
// Auto-uninstalls from orgs not in ALLOWED_ORGS
async function handleMetaEvent(eventName: string, payload: unknown, env: Env): Promise<void> {
  if (eventName !== "installation") return;

  const p = payload as {
    action?: string;
    installation?: { id?: number; account?: { login?: string } };
  };

  const installationId = p.installation?.id;
  const owner = p.installation?.account?.login;
  if (!installationId || !owner) return;

  const installLog = createLogger({ owner, installation_id: installationId });

  // Log all installation events
  if (p.action === "deleted") {
    installLog.info("installation_deleted");
    return;
  }

  if (p.action !== "created") return;

  // New installation - check if allowed
  if (isAllowedOrg(owner, env)) {
    installLog.info("installation_created");
    return;
  }

  // Org not in allowed list - delete the installation
  installLog.info("installation_rejected", {
    reason: "org_not_in_allowed_list",
  });
  try {
    await deleteInstallation(env, installationId);
    installLog.info("installation_auto_deleted");
  } catch (error) {
    installLog.errorWithException("installation_delete_failed", error);
  }
}

// Safety net for failed Bonk workflow runs. Tracked runs that were never
// finalized (network failure in finalize step) get a failure comment.
// Untracked runs (workflow variants, self-triggered, pre-track failures) are
// logged and metricked for observability but do not receive comments.
//
// NOTE: Requires "workflow_run" to be enabled in the GitHub App webhook event
// subscriptions (github.com > Developer Settings > GitHub Apps > Permissions & events).
async function handleWorkflowRunEvent(payload: WorkflowRunPayload, env: Env): Promise<void> {
  const parsed = parseWorkflowRunEvent(payload);
  if (!parsed) return;

  // Only process Bonk workflows -- ignore other workflows in the same repo.
  // Match on the workflow file path (e.g. ".github/workflows/bonk.yml") rather
  // than the display name, since users can customize the name but standard Bonk
  // filenames all start with "bonk" (bonk.yml, bonk-scheduled.yml, etc.).
  const filename = parsed.workflowPath.split("/").pop()?.toLowerCase() ?? "";
  if (!filename.startsWith("bonk")) {
    return;
  }

  const runLog = createLogger({
    owner: parsed.owner,
    repo: parsed.repo,
    run_id: parsed.runId,
  });
  runLog.info("workflow_run_received", {
    conclusion: parsed.conclusion,
    trigger_event: parsed.triggerEvent,
    workflow_path: parsed.workflowPath,
    run_url: parsed.runUrl,
  });

  // Extract an issue/PR number for the tracked-but-not-finalized path and
  // for observability logging on untracked runs. The pull_requests array is
  // populated for non-fork PRs; empty for fork PRs.
  const issueNumber = parsed.pullRequestNumbers[0];

  try {
    const agent = await getAgentByName<Env, RepoAgent>(
      env.REPO_AGENT,
      `${parsed.owner}/${parsed.repo}`,
    );
    await agent.handleWorkflowRunCompleted(
      parsed.runId,
      parsed.conclusion,
      parsed.runUrl,
      issueNumber,
      parsed.triggeringActor,
    );
  } catch (error) {
    // Only emit a metric when the handler itself fails. The agent emits
    // its own metrics for tracked/untracked failures internally.
    runLog.errorWithException("workflow_run_handler_failed", error);
    emitMetric(env, {
      repo: `${parsed.owner}/${parsed.repo}`,
      eventType: "webhook",
      eventSubtype: "workflow_run",
      status: "error",
      errorCode: error instanceof Error ? sanitizeSecrets(error.message).slice(0, 100) : "unknown",
      runId: parsed.runId,
      isPrivate: parsed.isPrivate,
    });
  }
}
