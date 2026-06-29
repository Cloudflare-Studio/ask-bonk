import { defineWorkflow } from "@flue/runtime";
import * as v from "valibot";
import { runTrackWorkflowJob, type TrackWorkflowJobPayload } from "../github-workflow-jobs";
import {
  internalWorkflowAgent,
  internalWorkflowRoute,
  runInternalWorkflowJob,
  workflowJobResultSchema,
} from "../internal-workflows";

export const route = internalWorkflowRoute;

export default defineWorkflow({
  agent: internalWorkflowAgent,
  input: v.object({
    owner: v.string(),
    repo: v.string(),
    run_id: v.number(),
    run_url: v.string(),
    issue_number: v.number(),
    created_at: v.string(),
    comment_id: v.optional(v.number()),
    review_comment_id: v.optional(v.number()),
    issue_id: v.optional(v.number()),
    actor: v.optional(v.string()),
  }),
  output: workflowJobResultSchema,
  async run(context) {
    return await runInternalWorkflowJob(context, (env) =>
      runTrackWorkflowJob(env, context.input satisfies TrackWorkflowJobPayload),
    );
  },
});
