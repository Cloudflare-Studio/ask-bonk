import type { FlueContext } from "@flue/runtime";
import { runFinalizeWorkflowJob, type FinalizeWorkflowJobPayload } from "../github-workflow-jobs";
import { internalWorkflowRoute } from "../internal-workflows";
import type { Env } from "../types";

export const route = internalWorkflowRoute;

export async function run({ env, payload }: FlueContext<FinalizeWorkflowJobPayload, Env>) {
  return await runFinalizeWorkflowJob(env, payload);
}
