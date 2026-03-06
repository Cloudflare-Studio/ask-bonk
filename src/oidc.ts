import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { RequestError } from "@octokit/request-error";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { Result } from "better-result";
import type { Env } from "./types";
import { createOctokit, hasWriteAccess, getRepository } from "./github";
import { createLogger } from "./log";
import {
  OIDCValidationError,
  AuthorizationError,
  InstallationNotFoundError,
  GitHubAPIError,
  type TokenExchangeError,
} from "./errors";
import { RETRY_CONFIG, APP_INSTALLATION_CACHE_TTL_SECS } from "./constants";

// GitHub's OIDC token issuer for Actions
const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

const JWKS = createRemoteJWKSet(new URL(`${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`));

// JWT claims from GitHub Actions OIDC token
export interface GitHubActionsJWTClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nbf?: number;
  jti?: string;
  // GitHub-specific claims
  repository: string;
  repository_owner: string;
  repository_id: string;
  repository_owner_id: string;
  run_id: string;
  run_number: string;
  run_attempt: string;
  actor: string;
  actor_id: string;
  workflow: string;
  head_ref?: string;
  base_ref?: string;
  event_name: string;
  ref: string;
  ref_type: string;
  job_workflow_ref: string;
  runner_environment: string;
}

// Validates a GitHub Actions OIDC token using jose library
export async function validateGitHubOIDCToken(
  token: string,
  expectedAudience: string = "opencode-github-action",
): Promise<Result<GitHubActionsJWTClaims, OIDCValidationError>> {
  return Result.tryPromise({
    try: async () => {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: GITHUB_ACTIONS_ISSUER,
        audience: expectedAudience,
      });
      // jose's jwtVerify returns JWTPayload (generic Record-like type) with no
      // way to parameterize it. The cast is unavoidable; the shape is validated
      // by the JWKS verification and GitHub's OIDC token contract.
      return payload as unknown as GitHubActionsJWTClaims;
    },
    catch: (e) =>
      new OIDCValidationError({
        message: e instanceof Error ? e.message : "Unknown error",
        cause: e,
      }),
  });
}

// Extracts owner/repo from OIDC claims.
// Returns Result to handle malformed repository claims.
export function extractRepoFromClaims(
  claims: GitHubActionsJWTClaims,
): Result<{ owner: string; repo: string }, OIDCValidationError> {
  const parts = claims.repository.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return Result.err(
      new OIDCValidationError({
        message: `Invalid repository claim: ${claims.repository}`,
      }),
    );
  }
  return Result.ok({ owner: parts[0], repo: parts[1] });
}

// Extracts bearer token from Authorization header.
// Returns null if header is missing or malformed.
export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return token ? token : null;
}

// Validates OIDC token and extracts repo info in one call.
// Common pattern used across /api/github/* endpoints.
export async function validateOIDCAndExtractRepo(
  token: string,
): Promise<
  Result<{ claims: GitHubActionsJWTClaims; owner: string; repo: string }, OIDCValidationError>
> {
  const validationResult = await validateGitHubOIDCToken(token);
  if (validationResult.isErr()) return validationResult;

  const claims = validationResult.value;
  const repoResult = extractRepoFromClaims(claims);
  if (repoResult.isErr()) return repoResult;

  return Result.ok({ claims, ...repoResult.value });
}

export type InstallationSource = "cache" | "api";

export interface InstallationLookup {
  id: number;
  source: InstallationSource;
}

// Gets or looks up the installation ID for a repository.
// Returns Result with InstallationNotFoundError for missing installations,
// or GitHubAPIError for transient failures.
export async function getInstallationId(
  env: Env,
  owner: string,
  repo: string,
): Promise<Result<InstallationLookup, InstallationNotFoundError | GitHubAPIError>> {
  const installLog = createLogger({ owner, repo });

  // Check cache first, with validation
  const cached = await env.APP_INSTALLATIONS.get(`${owner}/${repo}`);
  if (cached) {
    const id = parseInt(cached, 10);
    if (!Number.isNaN(id)) {
      return Result.ok({ id, source: "cache" as const });
    }
    installLog.warn("installation_cache_invalid", { cached_value: cached });
  }

  installLog.info(`[getInstallationId] Looking up installation for ${owner}/${repo} using App ID: ${env.GITHUB_APP_ID}`);

  // Look up via GitHub API using the app's JWT.
  // Both createAppAuth and auth() can throw (e.g., malformed private key),
  // so the entire flow is wrapped in Result.tryPromise.
  return Result.tryPromise(
    {
      try: async () => {
        const auth = createAppAuth({
          appId: env.GITHUB_APP_ID,
          privateKey: env.GITHUB_APP_PRIVATE_KEY,
        });

        const { token } = await auth({ type: "app" });
        const octokit = new Octokit({ auth: token });

        const response = await octokit.apps.getRepoInstallation({
          owner,
          repo,
        });
        const installationId = response.data.id;

        // Cache for future use
        await env.APP_INSTALLATIONS.put(`${owner}/${repo}`, String(installationId), {
          expirationTtl: APP_INSTALLATION_CACHE_TTL_SECS,
        });
        return { id: installationId, source: "api" as const };
      },
      catch: (err: unknown) => {
        // 404 = app not installed on this repo (expected case)
        if (err instanceof RequestError && err.status === 404) {
          return new InstallationNotFoundError({ owner, repo });
        }
        // Other errors (network, rate limit, 5xx, auth failures)
        return new GitHubAPIError({
          operation: "getRepoInstallation",
          cause: err,
          statusCode: err instanceof RequestError ? err.status : undefined,
        });
      },
    },
    { retry: RETRY_CONFIG },
  );
}

// Creates an Octokit client for a repo, retrying with a fresh installation lookup
// if a cached installation ID turns out to be stale (404 from token endpoint).
export async function createOctokitForRepo(
  env: Env,
  owner: string,
  repo: string,
  installation: InstallationLookup,
): Promise<{ octokit: Octokit; installation: InstallationLookup }> {
  try {
    const octokit = await createOctokit(env, installation.id);
    return { octokit, installation };
  } catch (error) {
    if (installation.source === "cache" && error instanceof RequestError && error.status === 404) {
      const log = createLogger({ owner, repo });
      log.warn("installation_cache_stale", {
        installation_id: installation.id,
      });
      await env.APP_INSTALLATIONS.delete(`${owner}/${repo}`);
      const freshResult = await getInstallationId(env, owner, repo);
      if (freshResult.isErr()) throw freshResult.error;
      const fresh = freshResult.value;
      log.info("installation_cache_refreshed", {
        old_installation_id: installation.id,
        installation_id: fresh.id,
      });
      const octokit = await createOctokit(env, fresh.id);
      return { octokit, installation: fresh };
    }
    throw error;
  }
}

// Token permission levels for installation tokens.
// Exported so callers and tests can reference the type.
export type TokenPermissions = {
  contents?: "read" | "write";
  issues?: "read" | "write";
  pull_requests?: "read" | "write";
  metadata?: "read";
};

// Named presets for common permission configurations.
// Callers pass the preset name as a string instead of constructing a JSON object.
export type TokenPermissionPreset = "NO_PUSH" | "WRITE";

// Callers may pass either a preset name or a custom permissions object.
export type TokenPermissionsInput = TokenPermissionPreset | TokenPermissions;

// Options for scoped installation token generation
interface ScopedTokenOptions {
  // Limit token to specific repository names
  repositoryNames?: string[];
  // Limit token permissions (defaults to full installation permissions)
  permissions?: TokenPermissions;
}

// Default permissions granted to installation tokens.
// These represent the maximum permissions the exchange endpoint will issue.
const DEFAULT_TOKEN_PERMISSIONS: Required<TokenPermissions> = {
  contents: "write",
  issues: "write",
  pull_requests: "write",
  metadata: "read",
};

// Named presets — each maps to a concrete TokenPermissions object.
// NO_PUSH: can read repo contents and post comments/reviews, but cannot push.
// WRITE: full write access (current default behavior).
const PERMISSION_PRESETS: Record<TokenPermissionPreset, Required<TokenPermissions>> = {
  NO_PUSH: {
    contents: "read",
    issues: "write",
    pull_requests: "write",
    metadata: "read",
  },
  WRITE: { ...DEFAULT_TOKEN_PERMISSIONS },
};

const PERMISSION_RANK: Record<string, number> = { read: 0, write: 1 };

// Resolves a TokenPermissionsInput (preset name or custom object) into a
// concrete permissions object, enforcing downgrade-only for custom objects.
//
// - undefined / null / falsy → defaults
// - Preset name (e.g., "NO_PUSH") → preset permissions
// - Custom object → merged with defaults; each key clamped to min(default, requested)
// - Unknown preset name → NO_PUSH (fail-closed; no existing callers to protect)
// - Non-object / array → NO_PUSH (fail-closed against untrusted JSON)
export function resolvePermissions(requested?: TokenPermissionsInput): Required<TokenPermissions> {
  if (!requested) return { ...DEFAULT_TOKEN_PERMISSIONS };

  // Preset name — fail-closed: unrecognized presets get the most restrictive preset
  if (typeof requested === "string") {
    const preset = PERMISSION_PRESETS[requested.toUpperCase() as TokenPermissionPreset];
    return preset ? { ...preset } : { ...PERMISSION_PRESETS.NO_PUSH };
  }

  // Reject non-plain-objects (arrays, numbers, etc. from untrusted JSON)
  if (typeof requested !== "object" || Array.isArray(requested)) {
    return { ...PERMISSION_PRESETS.NO_PUSH };
  }

  // Custom object — merge with defaults, downgrade only.
  // If the caller provided keys but none had valid values, fail closed to NO_PUSH.
  const resolved = { ...DEFAULT_TOKEN_PERMISSIONS };
  let anyAccepted = false;
  for (const key of Object.keys(DEFAULT_TOKEN_PERMISSIONS) as (keyof TokenPermissions)[]) {
    const requestedValue = requested[key];
    if (requestedValue === undefined) continue;

    // Only accept known permission levels — reject unexpected values from untrusted input
    if (requestedValue !== "read" && requestedValue !== "write") continue;

    anyAccepted = true;
    const defaultRank = PERMISSION_RANK[resolved[key]] ?? 0;
    const requestedRank = PERMISSION_RANK[requestedValue];

    // Only accept the requested value if it doesn't exceed the default
    if (requestedRank <= defaultRank) {
      (resolved as Record<string, string>)[key] = requestedValue;
    }
  }

  // Caller provided keys but none were valid — fail closed
  if (!anyAccepted && Object.keys(requested).length > 0) {
    return { ...PERMISSION_PRESETS.NO_PUSH };
  }

  return resolved;
}

// Generates an installation token for the GitHub App.
// Optionally scopes the token to specific repositories and/or permissions.
async function generateInstallationToken(
  env: Env,
  installationId: number,
  options?: ScopedTokenOptions,
): Promise<string> {
  const auth = createAppAuth({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    installationId,
  });

  const authOptions: {
    type: "installation";
    repositoryNames?: string[];
    permissions?: ScopedTokenOptions["permissions"];
  } = { type: "installation" };

  if (options?.repositoryNames) {
    authOptions.repositoryNames = options.repositoryNames;
  }
  if (options?.permissions) {
    authOptions.permissions = options.permissions;
  }

  const result = await Result.tryPromise(
    {
      try: () => auth(authOptions),
      catch: (e) => new GitHubAPIError({ operation: "generateInstallationToken", cause: e }),
    },
    { retry: RETRY_CONFIG },
  );
  if (result.isErr()) throw result.error;
  return result.value.token;
}

// Response types for API endpoints
export interface GetInstallationResponse {
  installation: {
    id: number;
  } | null;
}

export interface ExchangeTokenResponse {
  token: string;
}

// Handler for GET /get_github_app_installation
export async function handleGetInstallation(
  env: Env,
  owner: string,
  repo: string,
): Promise<GetInstallationResponse> {
  const result = await getInstallationId(env, owner, repo);

  if (result.isOk()) {
    return { installation: { id: result.value.id } };
  }

  // InstallationNotFoundError or GitHubAPIError - return null installation
  // Caller can retry on transient errors
  return { installation: null };
}

// Handler for POST /exchange_github_app_token
// Exchanges a GitHub Actions OIDC token for a GitHub App installation token.
// Callers may pass a `permissions` field in the request body — either a preset
// name ("NO_PUSH", "WRITE") or a custom permissions object. Escalation beyond
// defaults is silently clamped.
export async function handleExchangeToken(
  env: Env,
  authHeader: string | null,
  body?: { permissions?: TokenPermissionsInput },
): Promise<Result<ExchangeTokenResponse, TokenExchangeError>> {
  if (!authHeader?.startsWith("Bearer ")) {
    return Result.err(
      new AuthorizationError({
        message: "Missing or invalid Authorization header",
        reason: "missing_header",
      }),
    );
  }

  const oidcToken = authHeader.slice(7);

  // Validate the OIDC token
  const validationResult = await validateGitHubOIDCToken(oidcToken);
  if (validationResult.isErr()) {
    return Result.err(validationResult.error);
  }
  const claims = validationResult.value;

  // Extract repository info from claims
  const repoResult = extractRepoFromClaims(claims);
  if (repoResult.isErr()) {
    return Result.err(repoResult.error);
  }
  const { owner, repo } = repoResult.value;
  const exchangeLog = createLogger({
    owner,
    repo,
    actor: claims.actor,
    run_id: Number(claims.run_id) || undefined,
  });

  // Get installation ID
  const installationResult = await getInstallationId(env, owner, repo);
  if (installationResult.isErr()) {
    return Result.err(installationResult.error);
  }
  const { id: installationId, source: installationSource } = installationResult.value;

  // Generate scoped token — use caller-provided permissions (clamped to defaults)
  const permissions = resolvePermissions(body?.permissions);

  return Result.tryPromise({
    try: async () => {
      const token = await generateInstallationToken(env, installationId, {
        repositoryNames: [repo],
        permissions,
      });

      // Audit log: successful token exchange with resolved permissions
      exchangeLog.info("token_exchanged", {
        installation_id: installationId,
        installation_source: installationSource,
        requested_permissions: body?.permissions,
        resolved_permissions: permissions,
      });

      return { token };
    },
    catch: (err) => {
      exchangeLog.errorWithException("token_generation_failed", err, {
        installation_id: installationId,
        installation_source: installationSource,
      });
      return new GitHubAPIError({
        operation: "generateInstallationToken",
        cause: err,
      });
    },
  });
}

// Handler for POST /exchange_github_app_token_for_repo
// Exchanges a GitHub Actions OIDC token for a GitHub App installation token on a DIFFERENT repository.
// This enables cross-repo operations from GitHub Actions.
//
// Security controls:
// 1. Same-org restriction: The target repo must be in the same org/user as the source repo
// 2. Visibility restriction: Public repos cannot access private repos (prevents data exfiltration)
// 3. Actor write access: The actor (user who triggered the workflow) must have write access to the target repo
export async function handleExchangeTokenForRepo(
  env: Env,
  authHeader: string | null,
  body: { owner?: string; repo?: string },
): Promise<Result<ExchangeTokenResponse, TokenExchangeError>> {
  if (!authHeader?.startsWith("Bearer ")) {
    return Result.err(
      new AuthorizationError({
        message: "Missing or invalid Authorization header",
        reason: "missing_header",
      }),
    );
  }

  const oidcToken = authHeader.slice(7);

  // Validate the OIDC token
  const validationResult = await validateGitHubOIDCToken(oidcToken);
  if (validationResult.isErr()) {
    return Result.err(validationResult.error);
  }
  const claims = validationResult.value;

  // Target repo must be specified in body
  if (!body.owner || !body.repo) {
    return Result.err(
      new AuthorizationError({
        message: "Missing owner or repo in request body",
        reason: "invalid_format",
      }),
    );
  }

  // Bind after guard so TypeScript narrows the type for closures below
  const targetOwner = body.owner;
  const targetRepoName = body.repo;

  // Extract source repo info
  const repoResult = extractRepoFromClaims(claims);
  if (repoResult.isErr()) {
    return Result.err(repoResult.error);
  }
  const { owner: sourceOwner, repo: sourceRepoName } = repoResult.value;
  const sourceRepo = claims.repository;
  const targetRepo = `${targetOwner}/${targetRepoName}`;
  const actor = claims.actor;
  const crossRepoLog = createLogger({
    actor,
    source_repo: sourceRepo,
    target_repo: targetRepo,
  });

  // Security check 1: Same-org restriction
  if (sourceOwner !== targetOwner) {
    crossRepoLog.warn("cross_repo_denied_cross_org", {
      source_owner: sourceOwner,
      target_owner: targetOwner,
    });
    return Result.err(
      new AuthorizationError({
        message: `Cross-org access denied: workflow in ${sourceOwner} cannot access repos in ${targetOwner}`,
        reason: "cross_org",
      }),
    );
  }

  // Get installation IDs for both repos
  const sourceInstallationResult = await getInstallationId(env, sourceOwner, sourceRepoName);
  if (sourceInstallationResult.isErr()) {
    return Result.err(sourceInstallationResult.error);
  }
  const { id: sourceInstallationId, source: sourceInstallationSource } =
    sourceInstallationResult.value;

  const targetInstallationResult = await getInstallationId(env, targetOwner, targetRepoName);
  if (targetInstallationResult.isErr()) {
    return Result.err(targetInstallationResult.error);
  }
  const { id: targetInstallationId, source: targetInstallationSource } =
    targetInstallationResult.value;

  // Generate tokens for security checks
  return Result.tryPromise({
    try: async () => {
      const sourceToken = await generateInstallationToken(env, sourceInstallationId);
      const targetToken = await generateInstallationToken(env, targetInstallationId, {
        repositoryNames: [targetRepoName],
        permissions: { ...DEFAULT_TOKEN_PERMISSIONS },
      });

      const sourceOctokit = new Octokit({ auth: sourceToken });
      const targetOctokit = new Octokit({ auth: targetToken });

      // Security check 2: Visibility restriction
      // Octokit types `visibility` as `string`; the GitHub API only returns
      // "public" | "private" | "internal" but the generated types don't
      // narrow it. We compare against the string literal directly.
      const sourceData = await getRepository(sourceOctokit, sourceOwner, sourceRepoName);
      const targetData = await getRepository(targetOctokit, targetOwner, targetRepoName);

      if (sourceData.visibility === "public" && targetData.visibility !== "public") {
        crossRepoLog.warn("cross_repo_denied_visibility", {
          source_visibility: sourceData.visibility,
          target_visibility: targetData.visibility,
        });
        throw new AuthorizationError({
          message: "Cross-repo access denied: public repos cannot access private/internal repos",
          reason: "visibility",
        });
      }

      // Security check 3: Actor write access
      const hasAccess = await hasWriteAccess(targetOctokit, targetOwner, targetRepoName, actor);
      if (!hasAccess) {
        crossRepoLog.warn("cross_repo_denied_no_write_access");
        throw new AuthorizationError({
          message: `Access denied: ${actor} does not have write access to ${targetRepo}`,
          reason: "no_write_access",
        });
      }

      // Audit log: successful cross-repo token issuance
      crossRepoLog.info("cross_repo_token_issued", {
        source_installation_id: sourceInstallationId,
        source_installation_source: sourceInstallationSource,
        target_installation_id: targetInstallationId,
        target_installation_source: targetInstallationSource,
        source_visibility: sourceData.visibility,
        target_visibility: targetData.visibility,
        run_id: claims.run_id,
        workflow: claims.job_workflow_ref,
      });

      return { token: targetToken };
    },
    catch: (err) => {
      // Re-throw AuthorizationErrors directly (they're already our domain errors)
      if (AuthorizationError.is(err)) {
        return err;
      }
      crossRepoLog.errorWithException("cross_repo_token_generation_failed", err, {
        source_installation_id: sourceInstallationId,
        source_installation_source: sourceInstallationSource,
        target_installation_id: targetInstallationId,
        target_installation_source: targetInstallationSource,
      });
      return new GitHubAPIError({
        operation: "generateCrossRepoToken",
        cause: err,
      });
    },
  });
}

// Handler for POST /exchange_github_app_token_with_pat
// Exchanges a GitHub PAT for a GitHub App installation token (for testing/local development).
// DISABLED BY DEFAULT - set ENABLE_PAT_EXCHANGE=true to enable.
export async function handleExchangeTokenWithPAT(
  env: Env,
  authHeader: string | null,
  body: { owner?: string; repo?: string },
): Promise<Result<ExchangeTokenResponse, TokenExchangeError>> {
  // Security: PAT exchange is disabled by default
  if (env.ENABLE_PAT_EXCHANGE !== "true") {
    return Result.err(
      new AuthorizationError({
        message: "PAT exchange is disabled",
        reason: "invalid_token",
      }),
    );
  }

  if (!authHeader?.startsWith("Bearer ")) {
    return Result.err(
      new AuthorizationError({
        message: "Missing or invalid Authorization header",
        reason: "missing_header",
      }),
    );
  }

  const pat = authHeader.slice(7);

  // Only allow tokens that look like PATs
  if (!pat.startsWith("github_pat_") && !pat.startsWith("ghp_")) {
    return Result.err(
      new AuthorizationError({
        message: "Invalid token format - expected a GitHub PAT",
        reason: "invalid_format",
      }),
    );
  }

  if (!body.owner || !body.repo) {
    return Result.err(
      new AuthorizationError({
        message: "Missing owner or repo in request body",
        reason: "invalid_format",
      }),
    );
  }

  // Bind after guard so TypeScript narrows the type for closures below
  const patOwner = body.owner;
  const patRepoName = body.repo;
  const patLog = createLogger({ owner: patOwner, repo: patRepoName });

  // Verify the PAT has write access to the repository
  const octokit = new Octokit({ auth: pat });
  const patVerifyResult = await Result.tryPromise({
    try: async () => {
      const { data: repoData } = await octokit.repos.get({
        owner: patOwner,
        repo: patRepoName,
      });
      const permissions = repoData.permissions;
      if (!permissions?.admin && !permissions?.push && !permissions?.maintain) {
        throw new AuthorizationError({
          message: `PAT does not have write permissions for ${patOwner}/${patRepoName}`,
          reason: "no_write_access",
        });
      }
    },
    catch: (error) => {
      if (AuthorizationError.is(error)) return error;
      patLog.errorWithException("pat_exchange_denied_no_access", error);
      return new AuthorizationError({
        message: `PAT does not have access to ${patOwner}/${patRepoName}`,
        reason: "invalid_token",
      });
    },
  });
  if (patVerifyResult.isErr()) {
    return Result.err(patVerifyResult.error);
  }

  // Get installation ID
  const installationResult = await getInstallationId(env, patOwner, patRepoName);
  if (installationResult.isErr()) {
    return Result.err(installationResult.error);
  }
  const { id: installationId, source: installationSource } = installationResult.value;

  // Generate scoped token
  return Result.tryPromise({
    try: async () => {
      const token = await generateInstallationToken(env, installationId, {
        repositoryNames: [patRepoName],
        permissions: { ...DEFAULT_TOKEN_PERMISSIONS },
      });

      // Audit log: PAT exchange
      patLog.info("pat_token_exchanged", {
        installation_id: installationId,
        installation_source: installationSource,
      });

      return { token };
    },
    catch: (err) => {
      patLog.errorWithException("pat_token_exchange_failed", err, {
        installation_id: installationId,
        installation_source: installationSource,
      });
      return new GitHubAPIError({
        operation: "generateInstallationToken",
        cause: err,
      });
    },
  });
}
