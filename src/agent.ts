import { Agent } from "agents";
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
import { WORKFLOW_POLL_INTERVAL_SECS, MAX_WORKFLOW_TRACKING_MS } from "./constants";

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

  private get owner(): string {
    return this.name.split("/")[0] ?? "";
  }

  private get repo(): string {
    return this.name.split("/")[1] ?? "";
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
    this.setState({ ...this.state, installationId: id, installationSource: source });
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

    // Schedule polling as safety net
    await this.schedule<CheckStatusPayload>(
      WORKFLOW_POLL_INTERVAL_SECS,
      "checkWorkflowStatus",
      payload,
    );
    log.info("run_poll_scheduled", {
      poll_interval_seconds: WORKFLOW_POLL_INTERVAL_SECS,
    });
  }

  async finalizeRun(runId: number, status: string): Promise<void> {
    const run = this.state.activeRuns[runId];
    const log = this.logger(runId, run?.issueNumber);

    log.info("run_finalizing", { status });

    if (!run) {
      log.info("run_already_finalized");
      return;
    }

    this.removeAndRecordRun(runId);

    // Post failure comment + reaction for any non-success status.
    // The finalize step's conditions guarantee it only runs when the OpenCode
    // step was expected to execute, so "skipped" means an infrastructure step
    // failed and should be treated as a failure. The finalize script remaps
    // "skipped" -> "failure" client-side, but we also handle it here as
    // defense-in-depth.
    if (status !== "success") {
      await this.postFailureComment(runId, run.runUrl, run.issueNumber, status, run);
    } else {
      log.info("run_completed_no_comment", { status });
    }
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
    if (elapsed > MAX_WORKFLOW_TRACKING_MS) {
      log.warn("run_timed_out", {
        elapsed_ms: elapsed,
        max_tracking_ms: MAX_WORKFLOW_TRACKING_MS,
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
      await this.schedule<CheckStatusPayload>(
        WORKFLOW_POLL_INTERVAL_SECS,
        "checkWorkflowStatus",
        payload,
      );
      return;
    }

    try {
      const status = await getWorkflowRunStatus(octokit, this.owner, this.repo, runId);

      log.info("run_status_fetched", {
        status: status.status,
        conclusion: status.conclusion,
      });

      if (status.status === "completed") {
        this.removeAndRecordRun(runId);

        // On success, OpenCode posts the response - we stay silent
        if (status.conclusion !== "success") {
          await this.postFailureComment(
            runId,
            runUrl,
            issueNumber,
            status.conclusion,
            payload,
            octokit,
          );
        } else {
          log.info("run_succeeded");
        }
      } else {
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

        await this.schedule<CheckStatusPayload>(
          WORKFLOW_POLL_INTERVAL_SECS,
          "checkWorkflowStatus",
          payload,
        );
      }
    } catch (error) {
      log.errorWithException("run_status_check_failed", error);
      await this.schedule<CheckStatusPayload>(
        WORKFLOW_POLL_INTERVAL_SECS,
        "checkWorkflowStatus",
        payload,
      );
    }
  }

  // Handle a workflow_run.completed webhook. This is the safety net for runs
  // that were tracked but never finalized (network failure, etc.) and for runs
  // that were never tracked at all (OIDC failure before track step).
  //
  // issueNumber is optionally provided from the workflow_run payload's
  // pull_requests array (populated for non-fork PRs) to enable failure
  // comments even for runs that were never tracked.
  async handleWorkflowRunCompleted(
    runId: number,
    conclusion: string | null,
    runUrl: string,
    issueNumber?: number,
    actor?: string,
  ): Promise<void> {
    const log = this.logger(runId, issueNumber);

    // Run is still active -- finalize it now (the action's finalize call never arrived)
    if (this.state.activeRuns[runId]) {
      log.warn("run_finalized_by_workflow_webhook", { conclusion });
      await this.finalizeRun(runId, conclusion ?? "failure");
      return;
    }

    // Run was already finalized through the normal path -- nothing to do
    if (this.state.recentlyFinalizedRuns?.[runId]) {
      log.info("workflow_run_already_finalized");
      return;
    }

    // Run was never tracked (e.g., OIDC failure before track step, or
    // workflow needed approval and timed out / was cancelled).
    log.warn("run_untracked_failure", {
      conclusion,
      run_url: runUrl,
      issue_number: issueNumber,
    });

    // If we have an issue number (from pull_requests in the webhook payload),
    // post a failure comment so the user gets feedback.
    // postFailureComment emits its own metric, so we only emit here for the
    // no-issue-number path to avoid double-counting.
    if (issueNumber) {
      await this.postFailureComment(runId, runUrl, issueNumber, conclusion, undefined, undefined, actor);
    } else {
      emitMetric(this.env, {
        repo: `${this.owner}/${this.repo}`,
        eventType: "finalize",
        status: "failure",
        errorCode: `untracked: ${conclusion ?? "unknown"}`,
        runId,
      });
    }
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

  // Returns the state key for looking up / storing a failure comment.
  // Review thread triggers get a per-thread key; everything else is per-issue.
  private failureCommentKey(issueNumber: number, run?: CheckStatusPayload): string {
    if (run?.reactionTargetType === "pull_request_review_comment" && run.reactionTargetId) {
      return `rc:${run.reactionTargetId}`;
    }
    return `i:${issueNumber}`;
  }

  private storeFailureComment(key: string, commentId: number, commentType: FailureCommentRef["commentType"]): void {
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
        message = "Bonk workflow was not approved by a maintainer. This typically happens for pull requests from forks or first-time contributors.";
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
    const key = this.failureCommentKey(issueNumber, run);
    const isReviewThread = run?.reactionTargetType === "pull_request_review_comment" && run.reactionTargetId;

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
          log.info("failure_comment_edited", { conclusion, comment_id: existing.commentId, comment_type: existing.commentType });
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
        errorCode: error instanceof Error ? sanitizeSecrets(error.message).slice(0, 100) : "unknown",
        issueNumber,
        runId,
      });
    }
  }
}
