import { Agent, type Connection } from "agents";
import type { Octokit } from "@octokit/rest";
import type { Env } from "./types";
import {
  createComment,
  updateComment,
  createReviewCommentReply,
  updateReviewComment,
  getWorkflowRunStatus,
  type ReactionTarget,
} from "./github";
import { createLogger, sanitizeSecrets, type Logger } from "./log";
import { emitMetric } from "./metrics";
import { createOctokitForRepo, type InstallationSource, type InstallationLookup } from "./oidc";
import { WORKFLOW_POLL_INTERVAL_SECS, DEFAULT_MAX_WORKFLOW_TRACKING_MS } from "./constants";

export interface CheckStatusPayload {
  runId: number;
  runUrl: string;
  issueNumber: number;
  createdAt: number;
  // Who triggered Bonk — used for @-mention in failure comments
  actor?: string;
  // Reaction target for failure feedback on the original triggering comment
  reactionTargetId?: number;
  reactionTargetType?: ReactionTarget;
  // Tracks the "waiting for approval" comment so we can edit it on completion
  // instead of posting a duplicate. Also prevents retry loops on transient failures.
  waitingCommentPosted?: boolean;
  waitingCommentId?: number;
}

// TTL for recently finalized runs (1 hour). Entries older than this are pruned
// when new runs are finalized or workflow_run webhooks arrive.
const RECENTLY_FINALIZED_TTL_MS = 60 * 60 * 1000;

// TTL for stored failure comment refs (7 days). Older entries are pruned
// during state writes to avoid unbounded growth.
const FAILURE_COMMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Tracks a failure comment posted by Bonk so it can be edited in-place on retries.
interface FailureCommentRef {
  commentId: number;
  // "issue_comment" = top-level issue/PR comment (issues.updateComment)
  // "review_comment" = PR review comment reply (pulls.updateReviewComment)
  commentType: "issue_comment" | "review_comment";
  createdAt: number;
}

interface RepoAgentState {
  installationId: number;
  installationSource?: InstallationSource;
  // Persisted owner/repo so alarm-woken DOs can identify themselves without
  // relying on this.name (which requires setName() via a fetch request).
  // See: https://github.com/cloudflare/workerd/issues/2240
  owner?: string;
  repo?: string;
  // Active workflow runs being tracked, keyed by run ID
  activeRuns: Record<number, CheckStatusPayload>;
  // Recently finalized run IDs with timestamps, used to distinguish
  // "already handled" from "never tracked" in workflow_run webhooks
  recentlyFinalizedRuns?: Record<number, number>;
  // Failure comments posted by Bonk, keyed by context string.
  // Keys: "i:{issueNumber}" for top-level, "rc:{reviewCommentId}" for review threads.
  // Used for edit-in-place when retries fail again.
  failureComments?: Record<string, FailureCommentRef>;
}

// Tracks workflow runs per repo. ID format: "{owner}/{repo}"
//
// Three finalization paths (in order of preference):
// 1. Action calls PUT /api/github/track -> finalizeRun()
// 2. Polling safety net -> checkWorkflowStatus() detects completion/timeout
// 3. workflow_run webhook -> handleWorkflowRunCompleted() catches missed runs
export class RepoAgent extends Agent<Env, RepoAgentState> {
  initialState: RepoAgentState = { installationId: 0, activeRuns: {} };

  // Read owner/repo from persisted state first (always available, including
  // alarm wakeups), falling back to this.name for the initial RPC call before
  // state has been populated. this.name throws when the DO wakes from an alarm
  // because setName() is only called via fetch, not via alarm dispatch.
  // See: https://github.com/cloudflare/workerd/issues/2240
  private get owner(): string {
    if (this.state.owner) return this.state.owner;
    try {
      return this.name.split("/")[0] ?? "";
    } catch {
      return "";
    }
  }

  private get repo(): string {
    if (this.state.repo) return this.state.repo;
    try {
      return this.name.split("/")[1] ?? "";
    } catch {
      return "";
    }
  }

  // Structured error handler — replaces the default Agent.onError which logs
  // an unhelpful "Override onError(error) to handle server errors" message
  // and then rethrows.
  onError(connectionOrError: Connection | unknown, error?: unknown): void {
    const theError = error ?? connectionOrError;
    createLogger({
      owner: this.state.owner,
      repo: this.state.repo,
      installation_id: this.state.installationId || undefined,
    }).errorWithException("agent_error", theError);
  }

  private logger(runId?: number, issueNumber?: number): Logger {
    return createLogger({
      owner: this.owner,
      repo: this.repo,
      run_id: runId,
      issue_number: issueNumber,
      installation_id: this.state.installationId || undefined,
      installation_source: this.state.installationSource,
    });
  }

  async setInstallationId(id: number, source: InstallationSource): Promise<void> {
    // Persist owner/repo from this.name if not yet in state, so alarm wakeups
    // can identify the repo without relying on setName().
    let owner: string | undefined;
    let repo: string | undefined;
    if (!this.state.owner || !this.state.repo) {
      try {
        const parts = this.name.split("/");
        owner = parts[0] || undefined;
        repo = parts[1] || undefined;
      } catch {
        // this.name unavailable (alarm wakeup) — state should already have it
      }
    }
    this.setState({
      ...this.state,
      ...(owner && { owner }),
      ...(repo && { repo }),
      installationId: id,
      installationSource: source,
    });
  }

  // Wraps createOctokitForRepo with state updates on cache refresh.
  // Legacy DOs without installationSource are treated as cached (triggering retry on 404).
  private async getOctokit() {
    const installation: InstallationLookup = {
      id: this.state.installationId,
      source: this.state.installationSource ?? "cache",
    };
    const { octokit, installation: fresh } = await createOctokitForRepo(
      this.env,
      this.owner,
      this.repo,
      installation,
    );
    if (fresh.id !== this.state.installationId) {
      this.setState({
        ...this.state,
        installationId: fresh.id,
        installationSource: fresh.source,
      });
    }
    return octokit;
  }

  // Removes a run from activeRuns and records it in recentlyFinalizedRuns.
  // Called from all three finalization paths (action-driven, polling, timeout).
  private removeAndRecordRun(runId: number): void {
    const { [runId]: _, ...remainingRuns } = this.state.activeRuns;
    const recentlyFinalized = this.pruneRecentlyFinalized();
    recentlyFinalized[runId] = Date.now();
    this.setState({
      ...this.state,
      activeRuns: remainingRuns,
      recentlyFinalizedRuns: recentlyFinalized,
    });
  }

  // Best-effort reschedule of the polling safety net. If scheduling fails,
  // the workflow_run webhook acts as the secondary safety net.
  private reschedule(log: Logger, payload: CheckStatusPayload): void {
    this.schedule<CheckStatusPayload>(
      WORKFLOW_POLL_INTERVAL_SECS,
      "checkWorkflowStatus",
      payload,
    ).catch((error) => {
      log.errorWithException("run_reschedule_failed", error);
    });
  }

  async trackRun(
    runId: number,
    runUrl: string,
    issueNumber: number,
    reactionTarget?: { id: number; type: ReactionTarget },
    actor?: string,
  ): Promise<void> {
    const log = this.logger(runId, issueNumber);
    log.info("run_tracking_started", { run_url: runUrl, actor });

    const payload: CheckStatusPayload = {
      runId,
      runUrl,
      issueNumber,
      createdAt: Date.now(),
      actor,
      reactionTargetId: reactionTarget?.id,
      reactionTargetType: reactionTarget?.type,
    };

    // Store in activeRuns state
    const activeRuns = { ...this.state.activeRuns, [runId]: payload };
    this.setState({ ...this.state, activeRuns });

    // Schedule polling as safety net. Failure to schedule is non-fatal:
    // the workflow_run webhook acts as a secondary safety net.
    try {
      await this.schedule<CheckStatusPayload>(
        WORKFLOW_POLL_INTERVAL_SECS,
        "checkWorkflowStatus",
        payload,
      );
      log.info("run_poll_scheduled", {
        poll_interval_seconds: WORKFLOW_POLL_INTERVAL_SECS,
      });
    } catch (error) {
      log.errorWithException("run_poll_schedule_failed", error);
    }
  }

  async finalizeRun(
    runId: number,
    status: string,
    fallbackIssueNumber?: number,
    fallbackRunUrl?: string,
    actor?: string,
  ): Promise<void> {
    const run = this.state.activeRuns[runId];
    const issueNumber = run?.issueNumber ?? fallbackIssueNumber;
    const log = this.logger(runId, issueNumber);

    log.info("run_finalizing", { status, has_active_run: !!run });

    // Run was never tracked or was already removed (e.g., polling timeout
    // removed it before the action's finalize step arrived). For non-success
    // statuses, attempt to post a failure comment using fallback context from
    // the finalize request. Previously this returned silently, causing the
    // bug where failed runs produced no user-visible feedback.
    if (!run) {
      if (status === "success" || !issueNumber || !fallbackRunUrl) {
        log.info("run_already_finalized", {
          has_issue_number: !!issueNumber,
          has_run_url: !!fallbackRunUrl,
        });
        return;
      }
      log.warn("run_not_active_posting_failure", {
        recently_finalized: !!this.state.recentlyFinalizedRuns?.[runId],
      });
      await this.postFailureComment(
        runId,
        fallbackRunUrl,
        issueNumber,
        status,
        undefined,
        undefined,
        actor,
      );
      return;
    }

    this.removeAndRecordRun(runId);

    if (status === "success") {
      log.info("run_completed_no_comment", { status });
      return;
    }

    // Post failure comment for any non-success status.
    // The finalize step's conditions guarantee it only runs when the OpenCode
    // step was expected to execute, so "skipped" means an infrastructure step
    // failed and should be treated as a failure. The finalize script remaps
    // "skipped" -> "failure" client-side, but we also handle it here as
    // defense-in-depth.
    await this.postFailureComment(runId, run.runUrl, run.issueNumber, status, run);
  }

  async checkWorkflowStatus(payload: CheckStatusPayload): Promise<void> {
    const { runId, runUrl, issueNumber, createdAt } = payload;
    const log = this.logger(runId, issueNumber);

    // Check if run is still being tracked (may have been finalized by action)
    if (!this.state.activeRuns[runId]) {
      log.info("run_poll_skipped_already_finalized");
      return;
    }

    log.info("run_status_checking");

    const elapsed = Date.now() - createdAt;
    const override = Number(this.env.BONK_MAX_TRACK_SECS);
    const maxTrackingMs = override > 0 ? override * 1000 : DEFAULT_MAX_WORKFLOW_TRACKING_MS;
    if (elapsed > maxTrackingMs) {
      log.warn("run_timed_out", {
        elapsed_ms: elapsed,
        max_tracking_ms: maxTrackingMs,
      });
      this.removeAndRecordRun(runId);
      await this.postFailureComment(runId, runUrl, issueNumber, "timeout", payload);
      return;
    }

    let octokit;
    try {
      octokit = await this.getOctokit();
    } catch (error) {
      log.errorWithException("run_octokit_failed", error);
      this.reschedule(log, payload);
      return;
    }

    let status: { status: string; conclusion: string | null };
    try {
      status = await getWorkflowRunStatus(octokit, this.owner, this.repo, runId);
    } catch (error) {
      log.errorWithException("run_status_check_failed", error);
      this.reschedule(log, payload);
      return;
    }

    log.info("run_status_fetched", {
      status: status.status,
      conclusion: status.conclusion,
    });

    // Run finished — finalize and optionally post a failure comment.
    if (status.status === "completed") {
      this.removeAndRecordRun(runId);
      if (status.conclusion === "success") {
        log.info("run_succeeded");
        return;
      }
      await this.postFailureComment(
        runId,
        runUrl,
        issueNumber,
        status.conclusion,
        payload,
        octokit,
      );
      return;
    }

    // Detect "waiting" status (pending approval from a maintainer).
    // Post a one-time comment so the user isn't left wondering. If the run
    // later completes, postFailureComment edits this comment in-place.
    if (status.status === "waiting" && !payload.waitingCommentPosted) {
      log.info("run_waiting_for_approval");
      try {
        const commentId = await createComment(
          octokit,
          this.owner,
          this.repo,
          issueNumber,
          `Bonk workflow is waiting for approval from a maintainer before it can run.\n\n[Approve workflow run](${runUrl})`,
        );
        payload = { ...payload, waitingCommentPosted: true, waitingCommentId: commentId };
      } catch (commentError) {
        log.errorWithException("run_waiting_comment_failed", commentError);
        // Mark as posted even on failure to avoid a retry loop on
        // transient API errors — the comment is best-effort.
        payload = { ...payload, waitingCommentPosted: true };
      }
      const activeRuns = { ...this.state.activeRuns, [runId]: payload };
      this.setState({ ...this.state, activeRuns });
    }

    // Still running — reschedule the next poll.
    this.reschedule(log, payload);
  }

  // Handle a workflow_run.completed webhook. Safety net for tracked runs whose
  // finalize call never arrived (network failure, etc.). Untracked runs
  // (workflow variants, self-triggered, concurrency-cancelled) are logged and
  // metricked but do NOT receive failure comments.
  async handleWorkflowRunCompleted(
    runId: number,
    conclusion: string | null,
    runUrl: string,
    issueNumber?: number,
    actor?: string,
  ): Promise<void> {
    const log = this.logger(runId, issueNumber);

    // Run is still active — finalize it now (the action's finalize call never arrived)
    if (this.state.activeRuns[runId]) {
      log.warn("run_finalized_by_workflow_webhook", { conclusion });
      await this.finalizeRun(runId, conclusion ?? "failure", issueNumber, runUrl, actor);
      return;
    }

    // Run was already finalized through the normal path — nothing to do
    if (this.state.recentlyFinalizedRuns?.[runId]) {
      log.info("workflow_run_already_finalized");
      return;
    }

    // Run was never tracked via /api/github/track. Common causes:
    //   - bonk-* workflow variant (bonk-review.yml, bonk-scheduled.yml)
    //   - Self-triggered runs (Bonk's own review comments re-trigger bonk.yml)
    //   - Auto-cancelled superseded runs from concurrency groups
    //   - OIDC failure before the track step (rare)
    //
    // Do NOT post a comment -- there's no verified link between this run
    // and a user's /bonk invocation. The issue number is inferred from
    // workflow_run.pull_requests (branch-based matching), which can be
    // wrong for workflow variants or multi-PR branches. Emit a metric
    // for observability instead.
    log.warn("run_untracked_failure", {
      conclusion,
      run_url: runUrl,
      issue_number: issueNumber,
      actor,
    });
    emitMetric(this.env, {
      repo: `${this.owner}/${this.repo}`,
      eventType: "finalize",
      status: "failure",
      errorCode: `untracked: ${conclusion ?? "unknown"}`,
      runId,
    });
  }

  private pruneRecentlyFinalized(): Record<number, number> {
    const now = Date.now();
    const entries = this.state.recentlyFinalizedRuns ?? {};
    const pruned: Record<number, number> = {};
    for (const [id, ts] of Object.entries(entries)) {
      if (now - ts < RECENTLY_FINALIZED_TTL_MS) {
        pruned[Number(id)] = ts;
      }
    }
    return pruned;
  }

  private pruneFailureComments(): Record<string, FailureCommentRef> {
    const now = Date.now();
    const entries = this.state.failureComments ?? {};
    const pruned: Record<string, FailureCommentRef> = {};
    for (const [key, ref] of Object.entries(entries)) {
      if (now - ref.createdAt < FAILURE_COMMENT_TTL_MS) {
        pruned[key] = ref;
      }
    }
    return pruned;
  }

  private storeFailureComment(
    key: string,
    commentId: number,
    commentType: FailureCommentRef["commentType"],
  ): void {
    const failureComments = this.pruneFailureComments();
    failureComments[key] = { commentId, commentType, createdAt: Date.now() };
    this.setState({ ...this.state, failureComments });
  }

  private buildFailureBody(conclusion: string | null, runUrl: string, actor?: string): string {
    let message: string;
    switch (conclusion) {
      case "timeout":
        message = "Bonk workflow timed out.";
        break;
      case "failure":
        message = "Bonk workflow failed. Check the logs for details.";
        break;
      case "cancelled":
        message = "Bonk workflow was cancelled.";
        break;
      case "action_required":
        message =
          "Bonk workflow was not approved by a maintainer. This typically happens for pull requests from forks or first-time contributors.";
        break;
      default:
        message = `Bonk workflow finished with status: ${conclusion ?? "unknown"}.`;
        break;
    }

    // @-mention human actors (skip bots and unknown)
    const mention = actor && !actor.endsWith("[bot]") ? `@${actor} ` : "";

    return `${mention}${message}\n\n[View workflow run](${runUrl}) · To retry, trigger Bonk again.`;
  }

  // Posts or edits a failure comment. Replaces the old confused-reaction approach
  // with a visible, in-context comment that @-mentions the actor and edits
  // itself in-place on retries.
  //
  // Reply strategy:
  //   - pull_request_review_comment triggers -> reply in the review thread
  //   - everything else -> top-level issue/PR comment
  //
  // Edit-in-place priority:
  //   1. "waiting for approval" comment from an earlier poll -> edit that
  //   2. Prior failure comment for the same context key -> edit that
  //   3. Otherwise -> create new
  private async postFailureComment(
    runId: number,
    runUrl: string,
    issueNumber: number,
    conclusion: string | null,
    run?: CheckStatusPayload,
    existingOctokit?: Octokit,
    actor?: string,
  ): Promise<void> {
    const log = this.logger(runId, issueNumber);
    const effectiveActor = run?.actor ?? actor;
    const body = this.buildFailureBody(conclusion, runUrl, effectiveActor);
    const isReviewThread =
      run?.reactionTargetType === "pull_request_review_comment" && run.reactionTargetId;
    // Review thread triggers get a per-thread key; everything else is per-issue.
    const key = isReviewThread ? `rc:${run.reactionTargetId}` : `i:${issueNumber}`;

    // Emit workflow-failure metric unconditionally — callers in
    // handleWorkflowRunCompleted rely on this firing for every failure.
    emitMetric(this.env, {
      repo: `${this.owner}/${this.repo}`,
      eventType: "failure_comment",
      status: "failure",
      errorCode: conclusion ?? "unknown",
      issueNumber,
      runId,
    });

    try {
      const octokit = existingOctokit ?? (await this.getOctokit());

      // 1. Try editing a "waiting for approval" comment first (top-level only)
      if (run?.waitingCommentId) {
        try {
          await updateComment(octokit, this.owner, this.repo, run.waitingCommentId, body);
          const waitingKey = isReviewThread ? `i:${issueNumber}` : key;
          this.storeFailureComment(waitingKey, run.waitingCommentId, "issue_comment");
          log.info("failure_comment_updated_from_waiting", {
            conclusion,
            comment_id: run.waitingCommentId,
            in_review_thread: !!isReviewThread,
          });
          if (!isReviewThread) {
            return;
          }
        } catch (error) {
          // Comment may have been deleted — fall through to create new
          log.errorWithException("failure_comment_waiting_edit_failed", error);
        }
      }

      // 2. Try editing a prior failure comment for the same context
      const existing = this.state.failureComments?.[key];
      if (existing) {
        try {
          if (existing.commentType === "review_comment") {
            await updateReviewComment(octokit, this.owner, this.repo, existing.commentId, body);
          } else {
            await updateComment(octokit, this.owner, this.repo, existing.commentId, body);
          }
          // Refresh the timestamp so TTL resets
          this.storeFailureComment(key, existing.commentId, existing.commentType);
          log.info("failure_comment_edited", {
            conclusion,
            comment_id: existing.commentId,
            comment_type: existing.commentType,
          });
          return;
        } catch (error) {
          // Comment may have been deleted — fall through to create new
          log.errorWithException("failure_comment_edit_failed", error);
        }
      }

      // 3. Create a new comment in the appropriate context
      let commentId: number;
      let commentType: FailureCommentRef["commentType"];

      if (isReviewThread) {
        commentId = await createReviewCommentReply(
          octokit,
          this.owner,
          this.repo,
          issueNumber,
          run.reactionTargetId!,
          body,
        );
        commentType = "review_comment";
      } else {
        commentId = await createComment(octokit, this.owner, this.repo, issueNumber, body);
        commentType = "issue_comment";
      }

      this.storeFailureComment(key, commentId, commentType);
      log.info("failure_comment_created", {
        conclusion,
        comment_id: commentId,
        comment_type: commentType,
        in_review_thread: !!isReviewThread,
      });
    } catch (error) {
      log.errorWithException("failure_comment_failed", error, { conclusion });
      emitMetric(this.env, {
        repo: `${this.owner}/${this.repo}`,
        eventType: "failure_comment_error",
        status: "error",
        errorCode:
          error instanceof Error ? sanitizeSecrets(error.message).slice(0, 100) : "unknown",
        issueNumber,
        runId,
      });
    }
  }
}
