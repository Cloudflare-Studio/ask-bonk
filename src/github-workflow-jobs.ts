import { getAgentByName } from "agents";
import { ulid } from "ulid";
import type { RepoAgent } from "./agent";
import { createReaction, type ReactionTarget } from "./github";
import { createLogger, sanitizeSecrets } from "./log";
import { emitMetric } from "./metrics";
import { createOctokitForRepo, getInstallationId } from "./oidc";
import type { Env, FinalizeWorkflowRequest, SetupWorkflowRequest, TrackWorkflowRequest } from "./types";
import { ensureWorkflowFile, type SetupResult } from "./workflow";

export type WorkflowJobStatus = 200 | 404 | 500;
export interface WorkflowJobResult<TBody> {
  status: WorkflowJobStatus;
  body: TBody;
}

export type SetupWorkflowJobResult = WorkflowJobResult<SetupResult | { error: string }>;
export type TrackWorkflowJobResult = WorkflowJobResult<{ ok: true } | { error: string }>;
export type FinalizeWorkflowJobResult = WorkflowJobResult<
  { ok: true } | { ok: true; warning: string } | { error: string }
>;

export interface TrackWorkflowJobPayload extends TrackWorkflowRequest {
  actor?: string;
}

export interface FinalizeWorkflowJobPayload extends FinalizeWorkflowRequest {
  actor?: string;
}

// Determines the reaction target type and ID from a TrackWorkflowRequest.
// Returns null if no reaction target ID is present.
export function getReactionTarget(
  body: TrackWorkflowRequest,
): { targetId: number; targetType: ReactionTarget } | null {
  if (body.comment_id) return { targetId: body.comment_id, targetType: "issue_comment" };
  if (body.review_comment_id)
    return {
      targetId: body.review_comment_id,
      targetType: "pull_request_review_comment",
    };
  if (body.issue_id) return { targetId: body.issue_id, targetType: "issue" };
  return null;
}

export async function runSetupWorkflowJob(
  env: Env,
  body: SetupWorkflowRequest,
): Promise<SetupWorkflowJobResult> {
  const startTime = Date.now();
  const requestId = ulid();
  const setupLog = createLogger({
    request_id: requestId,
    owner: body.owner,
    repo: body.repo,
    issue_number: body.issue_number,
  });

  const installationResult = await getInstallationId(env, body.owner, body.repo);
  if (installationResult.isErr()) {
    setupLog.error("setup_no_installation", {
      duration_ms: Date.now() - startTime,
      error: installationResult.error.message,
    });
    return {
      status: 404,
      body: { error: `No GitHub App installation found for ${body.owner}/${body.repo}` },
    };
  }
  let { id: installationId, source: installationSource } = installationResult.value;

  try {
    const { octokit, installation } = await createOctokitForRepo(
      env,
      body.owner,
      body.repo,
      installationResult.value,
    );
    installationId = installation.id;
    installationSource = installation.source;

    const result = await ensureWorkflowFile(
      octokit,
      body.owner,
      body.repo,
      body.issue_number,
      body.default_branch,
    );

    setupLog.info("setup_completed", {
      installation_id: installationId,
      installation_source: installationSource,
      exists: result.exists,
      pr_url: result.prUrl ?? null,
      duration_ms: Date.now() - startTime,
    });
    emitMetric(env, {
      repo: `${body.owner}/${body.repo}`,
      eventType: "setup",
      status: "success",
      issueNumber: body.issue_number,
    });
    return { status: 200, body: result };
  } catch (error) {
    const message = sanitizeSecrets(error instanceof Error ? error.message : "Unknown error");
    setupLog.errorWithException("setup_failed", error, {
      installation_id: installationId,
      installation_source: installationSource,
      duration_ms: Date.now() - startTime,
    });
    emitMetric(env, {
      repo: `${body.owner}/${body.repo}`,
      eventType: "setup",
      status: "error",
      errorCode: message.slice(0, 100),
      issueNumber: body.issue_number,
    });
    return { status: 500, body: { error: message } };
  }
}

export async function runTrackWorkflowJob(
  env: Env,
  body: TrackWorkflowJobPayload,
): Promise<TrackWorkflowJobResult> {
  const startTime = Date.now();
  const requestId = ulid();
  const actor = body.actor;
  const trackLog = createLogger({
    request_id: requestId,
    owner: body.owner,
    repo: body.repo,
    issue_number: body.issue_number,
    run_id: body.run_id,
    actor,
  });

  const installationResult = await getInstallationId(env, body.owner, body.repo);
  if (installationResult.isErr()) {
    trackLog.error("track_no_installation", {
      duration_ms: Date.now() - startTime,
      error: installationResult.error.message,
    });
    return {
      status: 404,
      body: { error: `No GitHub App installation found for ${body.owner}/${body.repo}` },
    };
  }
  let { id: installationId, source: installationSource } = installationResult.value;

  try {
    const reactionTarget = getReactionTarget(body);
    if (reactionTarget) {
      const { octokit, installation } = await createOctokitForRepo(env, body.owner, body.repo, {
        id: installationId,
        source: installationSource,
      });
      installationId = installation.id;
      installationSource = installation.source;
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

    const agent = await getAgentByName<Env, RepoAgent>(env.REPO_AGENT, `${body.owner}/${body.repo}`);
    await agent.setInstallationId(installationId, installationSource);
    await agent.trackRun(
      body.run_id,
      body.run_url,
      body.issue_number,
      reactionTarget ? { id: reactionTarget.targetId, type: reactionTarget.targetType } : undefined,
      actor,
    );

    trackLog.info("track_completed", {
      installation_id: installationId,
      installation_source: installationSource,
      run_url: body.run_url,
      duration_ms: Date.now() - startTime,
    });
    emitMetric(env, {
      repo: `${body.owner}/${body.repo}`,
      eventType: "track",
      status: "success",
      actor,
      issueNumber: body.issue_number,
      runId: body.run_id,
    });
    return { status: 200, body: { ok: true } };
  } catch (error) {
    const message = sanitizeSecrets(error instanceof Error ? error.message : "Unknown error");
    trackLog.errorWithException("track_failed", error, {
      installation_id: installationId,
      installation_source: installationSource,
      duration_ms: Date.now() - startTime,
    });
    emitMetric(env, {
      repo: `${body.owner}/${body.repo}`,
      eventType: "track",
      status: "error",
      actor,
      errorCode: message.slice(0, 100),
      issueNumber: body.issue_number,
      runId: body.run_id,
    });
    return { status: 500, body: { error: message } };
  }
}

export async function runFinalizeWorkflowJob(
  env: Env,
  body: FinalizeWorkflowJobPayload,
): Promise<FinalizeWorkflowJobResult> {
  const startTime = Date.now();
  const requestId = ulid();
  const actor = body.actor;
  const finalizeLog = createLogger({
    request_id: requestId,
    owner: body.owner,
    repo: body.repo,
    run_id: body.run_id,
    actor,
  });

  const installationResult = await getInstallationId(env, body.owner, body.repo);
  if (installationResult.isErr()) {
    finalizeLog.error("finalize_no_installation", {
      duration_ms: Date.now() - startTime,
      error: installationResult.error.message,
    });
    return {
      status: 404,
      body: { error: `No GitHub App installation found for ${body.owner}/${body.repo}` },
    };
  }
  const { id: installationId, source: installationSource } = installationResult.value;

  try {
    const agent = await getAgentByName<Env, RepoAgent>(env.REPO_AGENT, `${body.owner}/${body.repo}`);
    await agent.setInstallationId(installationId, installationSource);
    await agent.finalizeRun(body.run_id, body.status, body.issue_number, body.run_url, actor);

    finalizeLog.info("finalize_completed", {
      installation_id: installationId,
      installation_source: installationSource,
      status: body.status,
      duration_ms: Date.now() - startTime,
    });
    emitMetric(env, {
      repo: `${body.owner}/${body.repo}`,
      eventType: "finalize",
      status: body.status,
      actor,
      runId: body.run_id,
    });
    return { status: 200, body: { ok: true } };
  } catch (error) {
    const message = sanitizeSecrets(error instanceof Error ? error.message : "Unknown error");
    finalizeLog.errorWithException("finalize_failed", error, {
      installation_id: installationId,
      installation_source: installationSource,
      duration_ms: Date.now() - startTime,
    });
    emitMetric(env, {
      repo: `${body.owner}/${body.repo}`,
      eventType: "finalize",
      status: "error",
      actor,
      errorCode: message.slice(0, 100),
      runId: body.run_id,
    });
    // Always return 200 for finalize - errors are logged but don't fail the action.
    return { status: 200, body: { ok: true, warning: message } };
  }
}
