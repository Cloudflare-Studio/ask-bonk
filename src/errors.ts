import { TaggedError } from "better-result";

// Authentication/OIDC errors
export class OIDCValidationError extends TaggedError("OIDCValidationError")<{
  message: string;
  cause?: unknown;
}>() {}

export class AuthorizationError extends TaggedError("AuthorizationError")<{
  message: string;
  reason:
    | "missing_header"
    | "invalid_format"
    | "invalid_token"
    | "cross_org"
    | "visibility"
    | "no_write_access";
}>() {}

// GitHub App installation errors
export class InstallationNotFoundError extends TaggedError("InstallationNotFoundError")<{
  owner: string;
  repo: string;
  message: string;
}>() {
  constructor(args: { owner: string; repo: string }) {
    super({
      ...args,
      message: `GitHub App not installed for ${args.owner}/${args.repo}`,
    });
  }
}

// API/request errors
export class ValidationError extends TaggedError("ValidationError")<{
  message: string;
  field?: string;
}>() {}

export class NotFoundError extends TaggedError("NotFoundError")<{
  resource: string;
  id: string;
  message: string;
}>() {
  constructor(args: { resource: string; id: string }) {
    super({ ...args, message: `${args.resource} not found: ${args.id}` });
  }
}

// Infrastructure errors (wrapping underlying exceptions)
export class GitHubAPIError extends TaggedError("GitHubAPIError")<{
  operation: string;
  message: string;
  cause: unknown;
  statusCode?: number;
}>() {
  constructor(args: { operation: string; cause: unknown; statusCode?: number }) {
    const msg = args.cause instanceof Error ? args.cause.message : String(args.cause);
    super({
      operation: args.operation,
      cause: args.cause,
      statusCode: args.statusCode,
      message: `GitHub API ${args.operation} failed: ${msg}`,
    });
  }
}

export class SandboxError extends TaggedError("SandboxError")<{
  operation: string;
  message: string;
  cause: unknown;
}>() {
  constructor(args: { operation: string; cause: unknown }) {
    const msg = args.cause instanceof Error ? args.cause.message : String(args.cause);
    super({ ...args, message: `Sandbox ${args.operation} failed: ${msg}` });
  }
}

// Union types for Result error channels
export type AuthError = OIDCValidationError | AuthorizationError;
export type TokenExchangeError = AuthError | InstallationNotFoundError | GitHubAPIError;
