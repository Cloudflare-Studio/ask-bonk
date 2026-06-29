import { defineWorkflow } from "@flue/runtime";
import * as v from "valibot";
import { runSetupWorkflowJob } from "../github-workflow-jobs";
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
    issue_number: v.number(),
    default_branch: v.string(),
  }),
  output: workflowJobResultSchema,
  async run(context) {
    return await runInternalWorkflowJob(context, (env) => runSetupWorkflowJob(env, context.input));
  },
});
