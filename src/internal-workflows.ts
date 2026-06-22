import type { WorkflowRouteHandler } from "@flue/runtime";

export const INTERNAL_WORKFLOW_HEADER = "x-bonk-internal-workflow";

// Internal compatibility routes call Flue workflows in-process. External callers
// must continue to use the OIDC-protected /api/github/* routes.
const internalWorkflowToken = crypto.randomUUID();

export const internalWorkflowRoute: WorkflowRouteHandler = async (c, next) => {
  if (c.req.header(INTERNAL_WORKFLOW_HEADER) !== internalWorkflowToken) {
    return c.notFound();
  }
  await next();
};

export function internalWorkflowHeaders(): Headers {
  return new Headers({
    "Content-Type": "application/json",
    [INTERNAL_WORKFLOW_HEADER]: internalWorkflowToken,
  });
}
