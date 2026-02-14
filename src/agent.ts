import { Agent } from "agents";
import type { Octokit } from "@octokit/rest";
import type { Env } from "./types";
import { createComment, updateComment, createReaction, getWorkflowRunStatus, type ReactionTarget } from "./github";
import { createLogger, type Logger } from "./log";
import { emitMetric } from "./metrics";
import { createOctokitForRepo, type InstallationSource, type InstallationLookup } from "./oidc";
import { WORKFLOW_POLL_INTERVAL_SECS, MAX_WORKFLOW_TRACKING_MS } from "./constants";

export interface CheckStatusPayload {
  runId: number;
  runUrl: string;
  issueNumber: number;
  createdAt: number;
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

interface RepoAgentState {
  installationId: number;
  installationSource?: InstallationSource;
  // Active workflow runs being tracked, keyed by run ID
  activeRuns: Record<number, CheckStatusPayload>;
  // Recently finalized run IDs with timestamps, used to distinguish
  // "already handled" from "never tracked" in workflow_run webhooks
  recentlyFinalizedRuns?: Record<number, number>;
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
  ): Promise<void> {
    const log = this.logger(runId, issueNumber);
    log.info("run_tracking_started", { run_url: runUrl });

    const payload: CheckStatusPayload = {
      runId,
      runUrl,
      issueNumber,
      createdAt: Date.now(),
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

    // Post failure comment + reaction if needed
    if (status !== "success" && status !== "skipped") {
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
          await this.postFailureComment(runId, runUrl, issueNumber, status.conclusion, payload, octokit);
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
      await this.postFailureComment(runId, runUrl, issueNumber, conclusion);
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

  private getFailureMessage(conclusion: string | null): string {
    switch (conclusion) {
      case "timeout":
        return "Bonk workflow timed out.";
      case "failure":
        return "Bonk workflow failed. Check the logs for details.";
      case "cancelled":
        return "Bonk workflow was cancelled.";
      case "action_required":
        return "Bonk workflow was not approved by a maintainer. This typically happens for pull requests from forks or first-time contributors.";
      default:
        return `Bonk workflow finished with status: ${conclusion ?? "unknown"}`;
    }
  }

  private async postFailureComment(
    runId: number,
    runUrl: string,
    issueNumber: number,
    conclusion: string | null,
    run?: CheckStatusPayload,
    existingOctokit?: Octokit,
  ): Promise<void> {
    const log = this.logger(runId, issueNumber);

    const body = `${this.getFailureMessage(conclusion)}\n\n[View workflow run](${runUrl})`;

    try {
      const octokit = existingOctokit ?? (await this.getOctokit());

      // If a waiting comment was posted earlier, edit it in-place instead of
      // creating a second near-identical comment.
      if (run?.waitingCommentId) {
        await updateComment(octokit, this.owner, this.repo, run.waitingCommentId, body);
        log.info("failure_comment_updated", { conclusion, comment_id: run.waitingCommentId });
      } else {
        await createComment(octokit, this.owner, this.repo, issueNumber, body);
        log.info("failure_comment_posted", { conclusion });
      }

      // Add a confused reaction on the original triggering comment.
      // createReaction() silently catches errors, so this won't throw.
      if (run?.reactionTargetId && run?.reactionTargetType) {
        await createReaction(
          octokit,
          this.owner,
          this.repo,
          run.reactionTargetId,
          "confused",
          run.reactionTargetType,
        );
        log.info("failure_reaction_added", {
          target_type: run.reactionTargetType,
          target_id: run.reactionTargetId,
        });
      }
    } catch (error) {
      log.errorWithException("failure_comment_failed", error, { conclusion });
    }

    // Emit failure metric to WAE so /stats/errors captures workflow failures
    emitMetric(this.env, {
      repo: `${this.owner}/${this.repo}`,
      eventType: "failure_comment",
      status: "failure",
      errorCode: conclusion ?? "unknown",
      issueNumber,
      runId,
    });
  }
}
