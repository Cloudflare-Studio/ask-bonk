import { defineAgent, type WorkflowRouteHandler } from "@flue/runtime";
import { getCloudflareContext } from "@flue/runtime/cloudflare";
import * as v from "valibot";
import type { Env } from "./types";

export const INTERNAL_WORKFLOW_HEADER = "x-bonk-internal-workflow";

export const workflowJobResultSchema = v.object({
  status: v.picklist([200, 404, 500]),
  body: v.any(),
});

export const internalWorkflowAgent = defineAgent(() => ({
  // Internal workflows are code-only, but Flue requires a resolvable model to initialize them.
  model: "anthropic/claude-haiku-4-5",
}));

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

function isInternalWorkflowEnv(value: unknown): value is Env {
  return (
    typeof value === "object" &&
    value !== null &&
    "REPO_AGENT" in value &&
    "APP_INSTALLATIONS" in value &&
    "RATE_LIMITER" in value &&
    "BONK_EVENTS" in value &&
    "GITHUB_APP_ID" in value &&
    "GITHUB_APP_PRIVATE_KEY" in value &&
    "GITHUB_WEBHOOK_SECRET" in value &&
    "DEFAULT_MODEL" in value &&
    "ALLOWED_ORGS" in value &&
    "BONK_VERSION" in value &&
    "BONK_COMMIT" in value
  );
}

export function getInternalWorkflowEnv(): Env {
  const env = getCloudflareContext().env;
  if (!isInternalWorkflowEnv(env)) {
    throw new Error("Internal workflow env is unavailable");
  }
  return env;
}
