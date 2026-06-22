import type { FlueContext } from "@flue/runtime";
import { runTrackWorkflowJob, type TrackWorkflowJobPayload } from "../github-workflow-jobs";
import { internalWorkflowRoute } from "../internal-workflows";
import type { Env } from "../types";

export const route = internalWorkflowRoute;

export async function run({ env, payload }: FlueContext<TrackWorkflowJobPayload, Env>) {
  return await runTrackWorkflowJob(env, payload);
}
