import { defineAgent, type ActionContext, type ActionInputSchema, type WorkflowRouteHandler } from "@flue/runtime";
import * as v from "valibot";
import type { Env } from "./types";

export const INTERNAL_WORKFLOW_HEADER = "x-bonk-internal-workflow";

export const workflowJobResultSchema = v.object({
  status: v.picklist([200, 404, 500]),
  body: v.any(),
});

const workflowEnvs = new Map<string, Env>();

export const internalWorkflowAgent = defineAgent<Env>(({ env, id }) => {
  workflowEnvs.set(id, env);
  return {
    // Internal workflows are code-only, but Flue requires a resolvable model to initialize them.
    model: "anthropic/claude-haiku-4-5",
  };
});

// Internal compatibility routes call Flue workflows in-process. External callers
// must continue to use the OIDC-protected /api/github/* routes.
let internalWorkflowToken: string | undefined;

function getInternalWorkflowToken(): string {
  internalWorkflowToken ??= crypto.randomUUID();
  return internalWorkflowToken;
}

export const internalWorkflowRoute: WorkflowRouteHandler = async (c, next) => {
  if (c.req.header(INTERNAL_WORKFLOW_HEADER) !== getInternalWorkflowToken()) {
    return c.notFound();
  }
  await next();
};

export function internalWorkflowHeaders(): Headers {
  return new Headers({
    "Content-Type": "application/json",
    [INTERNAL_WORKFLOW_HEADER]: getInternalWorkflowToken(),
  });
}

export async function runInternalWorkflowJob<T>(
  context: ActionContext<ActionInputSchema>,
  job: (env: Env) => Promise<T>,
): Promise<T> {
  const runId = Reflect.get(context.harness, "instanceId");
  if (typeof runId !== "string") {
    throw new Error("Internal workflow harness is missing its run id");
  }

  const env = workflowEnvs.get(runId);
  if (!env) {
    throw new Error("Internal workflow env is unavailable");
  }

  try {
    return await job(env);
  } finally {
    workflowEnvs.delete(runId);
  }
}
