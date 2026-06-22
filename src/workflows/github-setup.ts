import type { FlueContext } from "@flue/runtime";
import { runSetupWorkflowJob } from "../github-workflow-jobs";
import { internalWorkflowRoute } from "../internal-workflows";
import type { Env, SetupWorkflowRequest } from "../types";

export const route = internalWorkflowRoute;

export async function run({ env, payload }: FlueContext<SetupWorkflowRequest, Env>) {
  return await runSetupWorkflowJob(env, payload);
}
