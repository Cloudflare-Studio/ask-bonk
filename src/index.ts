import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { ulid } from "ulid";
import type {
  IssueCommentEvent,
  IssuesEvent,
  PullRequestReviewCommentEvent,
} from "@octokit/webhooks-types";
import type {
  Env,
  AskRequest,
  TrackWorkflowRequest,
  FinalizeWorkflowRequest,
  SetupWorkflowRequest,
} from "./types";
import {
  createOctokit,
  createWebhooks,
  verifyWebhook,
  createReaction,
  deleteInstallation,
  type ReactionTarget,
} from "./github";
import type { ScheduleEventPayload, WorkflowDispatchPayload } from "./types";
import {
  parseIssueCommentEvent,
  parseIssuesEvent,
  parsePRReviewCommentEvent,
  parseScheduleEvent,
  parseWorkflowDispatchEvent,
} from "./events";
import { ensureWorkflowFile } from "./workflow";
import {
  handleGetInstallation,
  handleExchangeToken,
  handleExchangeTokenForRepo,
  handleExchangeTokenWithPAT,
  getInstallationId,
  extractBearerToken,
  validateOIDCAndExtractRepo,
} from "./oidc";
import { RepoAgent } from "./agent";
import { runAsk } from "./sandbox";
import { getAgentByName } from "agents";
import {
  emitMetric,
  queryAnalyticsEngine,
  renderBarChart,
  eventsPerRepoQuery,
  errorsByRepoQuery,
  eventsByActorQuery,
} from "./metrics";
import { log, createLogger } from "./log";

export { Sandbox } from "@cloudflare/sandbox";
export { RepoAgent };

const GITHUB_REPO_URL = "https://github.com/ask-bonk/ask-bonk";

function isAllowedOrg(owner: string, env: Env): boolean {
  const allowed = env.ALLOWED_ORGS ?? [];
  if (allowed.length === 0) return true;
  return allowed.map((o) => o.toLowerCase()).includes(owner.toLowerCase());
}

// User-driven events: triggered by user actions (comments, issue creation)
// Repo-driven events: triggered by repository automation (schedule, workflow_dispatch)
// Meta events: GitHub App lifecycle events (installation)
const USER_EVENTS = [
  "issue_comment",
  "pull_request_review_comment",
  "issues",
] as const;
const REPO_EVENTS = ["schedule", "workflow_dispatch"] as const;
const META_EVENTS = ["installation"] as const;
const SUPPORTED_EVENTS = [
  ...USER_EVENTS,
  ...REPO_EVENTS,
  ...META_EVENTS,
] as const;

// Determines the reaction target type and ID from a TrackWorkflowRequest.
// Returns null if no reaction target ID is present.
function getReactionTarget(
  body: TrackWorkflowRequest,
): { targetId: number; targetType: ReactionTarget } | null {
  if (body.comment_id)
    return { targetId: body.comment_id, targetType: "issue_comment" };
  if (body.review_comment_id)
    return {
      targetId: body.review_comment_id,
      targetType: "pull_request_review_comment",
    };
  if (body.issue_id) return { targetId: body.issue_id, targetType: "issue" };
  return null;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.redirect(GITHUB_REPO_URL, 302));
app.get("/health", (c) => c.text("OK"));

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
  try {
    const data = await queryAnalyticsEngine(c.env, eventsPerRepoQuery);
    if (c.req.query("format") === "json") return c.json({ data });
    return c.text(
      renderBarChart(data, "Webhook events per repo (last 30d)", "repo", "event_count"),
    );
  } catch (error) {
    log.errorWithException("stats_query_failed", error);
    return c.json({ error: "Failed to query stats" }, 500);
  }
});

stats.get("/errors", async (c) => {
  try {
    const data = await queryAnalyticsEngine(c.env, errorsByRepoQuery);
    if (c.req.query("format") === "json") return c.json({ data });
    return c.text(
      renderBarChart(data, "Errors by repo (last 24h)", "repo", "error_count"),
    );
  } catch (error) {
    log.errorWithException("errors_query_failed", error);
    return c.json({ error: "Failed to query errors" }, 500);
  }
});

stats.get("/actors", async (c) => {
  try {
    const data = await queryAnalyticsEngine(c.env, eventsByActorQuery);
    if (c.req.query("format") === "json") return c.json({ data });
    return c.text(
      renderBarChart(data, "Mentions per actor (last 30d)", "actor", "event_count"),
    );
  } catch (error) {
    log.errorWithException("stats_query_failed", error);
    return c.json({ error: "Failed to query stats" }, 500);
  }
});

app.route("/stats", stats);

// Webhooks endpoint - receives GitHub events, logs them
// Tracking is now handled by the GitHub Action calling /api/github/track
app.post("/webhooks", async (c) => {
  return handleWebhook(c.req.raw, c.env);
});

// /ask endpoint - runs OpenCode directly in the sandbox
// Requires bearer auth with ASK_SECRET. Returns SSE stream.
// In future, responses may be routed to other destinations (email, Discord, etc)
const ask = new Hono<{ Bindings: Env }>();

ask.use("*", async (c, next) => {
  const secret = c.env.ASK_SECRET;
  // Empty or missing secret means endpoint is disabled
  if (!secret) {
    return c.json({ error: "Ask endpoint is disabled" }, 403);
  }
  const auth = bearerAuth({ token: secret });
  return auth(c, next);
});

ask.post("/", async (c) => {
  const startTime = Date.now();
  const askId = ulid();
  let rawBody: Omit<AskRequest, "id">;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Validate required fields
  if (!rawBody.owner || !rawBody.repo || !rawBody.prompt) {
    return c.json(
      { error: "Missing required fields: owner, repo, prompt" },
      400,
    );
  }

  // Build full request with ID
  const body: AskRequest = { id: askId, ...rawBody };
  const askLog = createLogger({
    request_id: askId,
    owner: body.owner,
    repo: body.repo,
  });

  // Look up installation ID for this repo (uses cache, falls back to GitHub API)
  const installationResult = await getInstallationId(
    c.env,
    body.owner,
    body.repo,
  );
  if (installationResult.isErr()) {
    askLog.error("ask_no_installation", {
      duration_ms: Date.now() - startTime,
      error: installationResult.error.message,
    });
    return c.json(
      {
        error: `No GitHub App installation found for ${body.owner}/${body.repo}`,
      },
      404,
    );
  }
  const installationId = installationResult.value;

  const streamResult = await runAsk(c.env, installationId, body);
  if (streamResult.isErr()) {
    askLog.errorWithException("ask_failed", streamResult.error, {
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: streamResult.error.message }, 500);
  }

  // duration_ms logged in sandbox.ts when prompt completes (sandbox_prompt_completed)
  return new Response(streamResult.value, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

app.route("/ask", ask);

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
  const result = await handleExchangeToken(c.env, authHeader);

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

  const result = await handleExchangeTokenForRepo(
    c.env,
    authHeader ?? null,
    body,
  );
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

  const result = await handleExchangeTokenWithPAT(
    c.env,
    authHeader ?? null,
    body,
  );
  if (result.isErr()) {
    return c.json({ error: result.error.message }, 401);
  }
  return c.json(result.value);
});

app.route("/auth", auth);

// GitHub API endpoints - called by the GitHub Action for tracking
const apiGithub = new Hono<{ Bindings: Env }>();

// POST /api/github/setup - Check if workflow file exists, create PR if not
apiGithub.post("/setup", async (c) => {
  const startTime = Date.now();
  const requestId = ulid();

  const oidcToken = extractBearerToken(c.req.header("Authorization"));
  if (!oidcToken)
    return c.json({ error: "Missing or invalid Authorization header" }, 401);

  let body: SetupWorkflowRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.owner || !body.repo || !body.issue_number || !body.default_branch) {
    return c.json(
      {
        error:
          "Missing required fields: owner, repo, issue_number, default_branch",
      },
      400,
    );
  }

  const oidcResult = await validateOIDCAndExtractRepo(oidcToken);
  if (oidcResult.isErr())
    return c.json({ error: oidcResult.error.message }, 401);

  const { owner: claimsOwner, repo: claimsRepo } = oidcResult.value;
  if (claimsOwner !== body.owner || claimsRepo !== body.repo) {
    return c.json(
      {
        error: `OIDC token is for ${claimsOwner}/${claimsRepo}, not ${body.owner}/${body.repo}`,
      },
      403,
    );
  }

  const setupLog = createLogger({
    request_id: requestId,
    owner: body.owner,
    repo: body.repo,
    issue_number: body.issue_number,
  });

  // Look up installation ID
  const installationResult = await getInstallationId(
    c.env,
    body.owner,
    body.repo,
  );
  if (installationResult.isErr()) {
    setupLog.error("setup_no_installation", {
      duration_ms: Date.now() - startTime,
      error: installationResult.error.message,
    });
    return c.json(
      {
        error: `No GitHub App installation found for ${body.owner}/${body.repo}`,
      },
      404,
    );
  }
  const installationId = installationResult.value;

  try {
    const octokit = await createOctokit(c.env, installationId);
    const result = await ensureWorkflowFile(
      octokit,
      body.owner,
      body.repo,
      body.issue_number,
      body.default_branch,
    );

    setupLog.info("setup_completed", {
      exists: result.exists,
      pr_url: result.prUrl ?? null,
      duration_ms: Date.now() - startTime,
    });
    emitMetric(c.env, {
      repo: `${body.owner}/${body.repo}`,
      eventType: "setup",
      status: "success",
      issueNumber: body.issue_number,
    });
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    setupLog.errorWithException("setup_failed", error, {
      duration_ms: Date.now() - startTime,
    });
    emitMetric(c.env, {
      repo: `${body.owner}/${body.repo}`,
      eventType: "setup",
      status: "error",
      errorCode: message.slice(0, 100),
      issueNumber: body.issue_number,
    });
    return c.json({ error: message }, 500);
  }
});

// POST /api/github/track - Start tracking a workflow run
apiGithub.post("/track", async (c) => {
  const startTime = Date.now();
  const requestId = ulid();

  const oidcToken = extractBearerToken(c.req.header("Authorization"));
  if (!oidcToken)
    return c.json({ error: "Missing or invalid Authorization header" }, 401);

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
        error:
          "Missing required fields: owner, repo, run_id, run_url, issue_number, created_at",
      },
      400,
    );
  }

  const oidcResult = await validateOIDCAndExtractRepo(oidcToken);
  if (oidcResult.isErr())
    return c.json({ error: oidcResult.error.message }, 401);

  const { owner: claimsOwner, repo: claimsRepo } = oidcResult.value;
  if (claimsOwner !== body.owner || claimsRepo !== body.repo) {
    return c.json(
      {
        error: `OIDC token is for ${claimsOwner}/${claimsRepo}, not ${body.owner}/${body.repo}`,
      },
      403,
    );
  }

  const trackLog = createLogger({
    request_id: requestId,
    owner: body.owner,
    repo: body.repo,
    issue_number: body.issue_number,
    run_id: body.run_id,
  });

  // Look up installation ID
  const installationResult = await getInstallationId(
    c.env,
    body.owner,
    body.repo,
  );
  if (installationResult.isErr()) {
    trackLog.error("track_no_installation", {
      duration_ms: Date.now() - startTime,
      error: installationResult.error.message,
    });
    return c.json(
      {
        error: `No GitHub App installation found for ${body.owner}/${body.repo}`,
      },
      404,
    );
  }
  const installationId = installationResult.value;

  try {
    // Create reaction if comment/issue ID provided
    const reactionTarget = getReactionTarget(body);
    if (reactionTarget) {
      const octokit = await createOctokit(c.env, installationId);
      await createReaction(
        octokit,
        body.owner,
        body.repo,
        reactionTarget.targetId,
        "+1",
        reactionTarget.targetType,
      );
      trackLog.info("reaction_created", {
        target_type: reactionTarget.targetType,
        target_id: reactionTarget.targetId,
      });
    }

    // Get/create RepoAgent and start tracking
    const agent = await getAgentByName<Env, RepoAgent>(
      c.env.REPO_AGENT,
      `${body.owner}/${body.repo}`,
    );
    await agent.setInstallationId(installationId);
    await agent.trackRun(body.run_id, body.run_url, body.issue_number);

    trackLog.info("track_completed", {
      run_url: body.run_url,
      duration_ms: Date.now() - startTime,
    });
    emitMetric(c.env, {
      repo: `${body.owner}/${body.repo}`,
      eventType: "track",
      status: "success",
      issueNumber: body.issue_number,
      runId: body.run_id,
    });
    return c.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    trackLog.errorWithException("track_failed", error, {
      duration_ms: Date.now() - startTime,
    });
    emitMetric(c.env, {
      repo: `${body.owner}/${body.repo}`,
      eventType: "track",
      status: "error",
      errorCode: message.slice(0, 100),
      issueNumber: body.issue_number,
      runId: body.run_id,
    });
    return c.json({ error: message }, 500);
  }
});

// PUT /api/github/track - Finalize tracking a workflow run
apiGithub.put("/track", async (c) => {
  const startTime = Date.now();
  const requestId = ulid();

  const oidcToken = extractBearerToken(c.req.header("Authorization"));
  if (!oidcToken)
    return c.json({ error: "Missing or invalid Authorization header" }, 401);

  let body: FinalizeWorkflowRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.owner || !body.repo || !body.run_id || !body.status) {
    return c.json(
      { error: "Missing required fields: owner, repo, run_id, status" },
      400,
    );
  }

  const oidcResult = await validateOIDCAndExtractRepo(oidcToken);
  if (oidcResult.isErr())
    return c.json({ error: oidcResult.error.message }, 401);

  const { owner: claimsOwner, repo: claimsRepo } = oidcResult.value;
  if (claimsOwner !== body.owner || claimsRepo !== body.repo) {
    return c.json(
      {
        error: `OIDC token is for ${claimsOwner}/${claimsRepo}, not ${body.owner}/${body.repo}`,
      },
      403,
    );
  }

  const finalizeLog = createLogger({
    request_id: requestId,
    owner: body.owner,
    repo: body.repo,
    run_id: body.run_id,
  });

  // Look up installation ID
  const installationResult = await getInstallationId(
    c.env,
    body.owner,
    body.repo,
  );
  if (installationResult.isErr()) {
    finalizeLog.error("finalize_no_installation", {
      duration_ms: Date.now() - startTime,
      error: installationResult.error.message,
    });
    return c.json(
      {
        error: `No GitHub App installation found for ${body.owner}/${body.repo}`,
      },
      404,
    );
  }
  const installationId = installationResult.value;

  try {
    // Get RepoAgent and finalize
    const agent = await getAgentByName<Env, RepoAgent>(
      c.env.REPO_AGENT,
      `${body.owner}/${body.repo}`,
    );
    await agent.setInstallationId(installationId);
    await agent.finalizeRun(body.run_id, body.status);

    finalizeLog.info("finalize_completed", {
      status: body.status,
      duration_ms: Date.now() - startTime,
    });
    emitMetric(c.env, {
      repo: `${body.owner}/${body.repo}`,
      eventType: "finalize",
      status: body.status,
      runId: body.run_id,
    });
    return c.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    finalizeLog.errorWithException("finalize_failed", error, {
      duration_ms: Date.now() - startTime,
    });
    emitMetric(c.env, {
      repo: `${body.owner}/${body.repo}`,
      eventType: "finalize",
      status: "error",
      errorCode: message.slice(0, 100),
      runId: body.run_id,
    });
    // Always return 200 for finalize - errors are logged but don't fail the action
    return c.json({ ok: true, warning: message });
  }
});

app.route("/api/github", apiGithub);

export default app;

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const startTime = Date.now();
  const requestId = ulid();
  const webhooks = createWebhooks(env);
  const eventResult = await verifyWebhook(webhooks, request);
  if (eventResult.isErr()) {
    log.error("webhook_signature_invalid", {
      error: eventResult.error.message,
    });
    return new Response("Invalid signature", { status: 401 });
  }
  const event = eventResult.value;

  // Installation ID caching is handled by getInstallationId() in oidc.ts on cache miss.
  // This avoids redundant KV writes on every webhook (see issue #52).
  const payload = event.payload as Record<string, unknown>;
  const repository = payload.repository as
    | { owner?: { login?: string }; name?: string }
    | undefined;
  const owner = repository?.owner?.login;
  const repoName = repository?.name;
  const repoKey =
    owner && repoName ? `${owner}/${repoName}` : "unknown/unknown";
  const sender = (payload.sender as { login?: string })?.login;
  const issue = payload.issue as { number?: number } | undefined;
  const pr = payload.pull_request as { number?: number } | undefined;
  const issueNumber = issue?.number ?? pr?.number;
  const isPrivate = (repository as { private?: boolean })?.private;
  const isPullRequest = !!pr;

  const webhookLog = createLogger({
    request_id: requestId,
    owner: owner ?? "unknown",
    repo: repoName ?? "unknown",
    issue_number: issueNumber,
    actor: sender,
  });

  try {
    // Handle meta events (installation) before other checks - these may delete installations
    const isMetaEvent = META_EVENTS.includes(
      event.name as (typeof META_EVENTS)[number],
    );
    if (isMetaEvent) {
      await handleMetaEvent(event.name, event.payload, env);
      webhookLog.info("webhook_completed", {
        event_type: event.name,
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

    if (
      !SUPPORTED_EVENTS.includes(
        event.name as (typeof SUPPORTED_EVENTS)[number],
      )
    ) {
      webhookLog.info("webhook_unsupported_event", {
        event_type: event.name,
        duration_ms: Date.now() - startTime,
      });
      return new Response("OK", { status: 200 });
    }

    // Route events to appropriate handlers based on type
    // All handlers now just log - tracking is done via /api/github/track
    const isUserEvent = USER_EVENTS.includes(
      event.name as (typeof USER_EVENTS)[number],
    );
    if (isUserEvent) {
      await handleUserEvent(event.name, event.payload, env);
    } else {
      await handleRepoEvent(event.name, event.payload, env);
    }

    webhookLog.info("webhook_completed", {
      event_type: event.name,
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
      duration_ms: Date.now() - startTime,
    });
    emitMetric(env, {
      repo: repoKey,
      eventType: "webhook",
      eventSubtype: event.name,
      status: "error",
      actor: sender,
      errorCode:
        error instanceof Error ? error.message.slice(0, 100) : "unknown",
      issueNumber,
      isPrivate,
      isPullRequest,
    });
    return new Response("Internal error", { status: 500 });
  }
}

// User-driven events: issue comments, PR review comments, issues
// Now just logs the event - tracking is done by the action calling /api/github/track
async function handleUserEvent(
  eventName: string,
  payload: unknown,
  _env: Env,
): Promise<void> {
  switch (eventName) {
    case "issue_comment":
      await handleIssueComment(payload as IssueCommentEvent);
      break;
    case "pull_request_review_comment":
      await handlePRReviewComment(payload as PullRequestReviewCommentEvent);
      break;
    case "issues":
      await handleIssuesEvent(payload as IssuesEvent);
      break;
  }
}

// Repo-driven events: schedule, workflow_dispatch
// Just logs - processed by the GitHub Action directly
async function handleRepoEvent(
  eventName: string,
  payload: unknown,
  _env: Env,
): Promise<void> {
  switch (eventName) {
    case "schedule":
      await handleScheduleEvent(payload as ScheduleEventPayload);
      break;
    case "workflow_dispatch":
      await handleWorkflowDispatchEvent(payload as WorkflowDispatchPayload);
      break;
  }
}

// Meta events: GitHub App lifecycle events (installation)
// Handles GitHub App installation lifecycle events (created, deleted)
// Auto-uninstalls from orgs not in ALLOWED_ORGS
async function handleMetaEvent(
  eventName: string,
  payload: unknown,
  env: Env,
): Promise<void> {
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

async function handleIssueComment(payload: IssueCommentEvent): Promise<void> {
  const parsed = parseIssueCommentEvent(payload);
  if (!parsed) return;

  createLogger({
    owner: parsed.context.owner,
    repo: parsed.context.repo,
    issue_number: parsed.context.issueNumber,
    actor: parsed.context.actor,
  }).info("issue_comment_received");
}

async function handlePRReviewComment(
  payload: PullRequestReviewCommentEvent,
): Promise<void> {
  const parsed = parsePRReviewCommentEvent(payload);
  if (!parsed) return;

  createLogger({
    owner: parsed.context.owner,
    repo: parsed.context.repo,
    issue_number: parsed.context.issueNumber,
    actor: parsed.context.actor,
  }).info("pr_review_comment_received");
}

// Schedule events are handled by the GitHub Action directly - Bonk webhook just logs
async function handleScheduleEvent(
  payload: ScheduleEventPayload,
): Promise<void> {
  const parsed = parseScheduleEvent(payload);
  if (!parsed) {
    log.error("schedule_event_invalid");
    return;
  }

  createLogger({ owner: parsed.owner, repo: parsed.repo }).info(
    "schedule_event_received",
    { schedule: parsed.schedule },
  );
}

async function handleIssuesEvent(payload: IssuesEvent): Promise<void> {
  const parsed = parseIssuesEvent(payload);
  if (!parsed) return;

  createLogger({
    owner: parsed.context.owner,
    repo: parsed.context.repo,
    issue_number: parsed.context.issueNumber,
    actor: parsed.context.actor,
  }).info("issues_event_received", { action: payload.action });
}

// Handle workflow_dispatch events for manual workflow triggers.
async function handleWorkflowDispatchEvent(
  payload: WorkflowDispatchPayload,
): Promise<void> {
  const parsed = parseWorkflowDispatchEvent(payload);
  if (!parsed) {
    log.error("workflow_dispatch_invalid");
    return;
  }

  createLogger({
    owner: parsed.owner,
    repo: parsed.repo,
    actor: parsed.sender,
  }).info("workflow_dispatch_received");
}
