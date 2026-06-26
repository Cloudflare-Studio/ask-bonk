import type { WorkflowRouteHandler } from "@flue/runtime";

export const INTERNAL_WORKFLOW_HEADER = "x-bonk-internal-workflow";

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
