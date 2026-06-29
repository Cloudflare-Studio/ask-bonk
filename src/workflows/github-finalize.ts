import { defineWorkflow } from "@flue/runtime";
import * as v from "valibot";
import { runFinalizeWorkflowJob, type FinalizeWorkflowJobPayload } from "../github-workflow-jobs";
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
    status: v.picklist(["success", "failure", "cancelled", "skipped"]),
    issue_number: v.optional(v.number()),
    run_url: v.optional(v.string()),
    actor: v.optional(v.string()),
  }),
  output: workflowJobResultSchema,
  async run(context) {
    return await runInternalWorkflowJob(context, (env) =>
      runFinalizeWorkflowJob(env, context.input satisfies FinalizeWorkflowJobPayload),
    );
  },
});
