// Check user permission before running OpenCode.
//
// Supports "admin", "write", "any", and "CODEOWNERS" permission levels.
// CODEOWNERS checks parse .github/CODEOWNERS, CODEOWNERS, or docs/CODEOWNERS
// and verify the actor is listed directly or via team membership.
//
// Replaces the actions/github-script permission check step to avoid
// downloading and bootstrapping the JavaScript action on every run.

import { core } from "./context";
import { fetchWithRetry } from "./http";

const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

interface ContentResponse {
  content: string;
}

interface TeamMembershipResponse {
  state?: string;
}

async function githubApi<T>(path: string, token: string): Promise<T | null> {
  const resp = await fetchWithRetry(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!resp.ok) {
    if (resp.status === 404) return null;
    throw new Error(`GitHub API ${path} returned ${resp.status}: ${await resp.text()}`);
  }
  return (await resp.json()) as T;
}

// Parse CODEOWNERS file and return individual owners and team patterns.
function parseCodeowners(content: string): {
  owners: Set<string>;
  teamPatterns: string[];
} {
  const owners = new Set<string>();
  const teamPatterns: string[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const mentions = trimmed.match(/@[\w-]+(?:\/[\w-]+)?/g) || [];
    for (const mention of mentions) {
      if (mention.includes("/")) {
        // Team pattern: @org/team
        teamPatterns.push(mention.substring(1));
      } else {
        // Individual user (case-insensitive)
        owners.add(mention.substring(1).toLowerCase());
      }
    }
  }

  return { owners, teamPatterns };
}

async function checkCodeowners(
  owner: string,
  repo: string,
  ref: string,
  actor: string,
  token: string,
): Promise<void> {
  let codeownersContent = "";

  for (const path of CODEOWNERS_PATHS) {
    const data = await githubApi<ContentResponse>(
      `/repos/${owner}/${repo}/contents/${path}?ref=${ref || "HEAD"}`,
      token,
    );
    if (data?.content) {
      codeownersContent = Buffer.from(data.content, "base64").toString("utf8");
      core.info(`Found CODEOWNERS at ${path}`);
      break;
    }
  }

  if (!codeownersContent) {
    return core.setFailed("CODEOWNERS file not found in .github/, root, or docs/ directory");
  }

  const { owners, teamPatterns } = parseCodeowners(codeownersContent);
  const actorLower = actor.toLowerCase();

  if (owners.has(actorLower)) {
    core.info(`User ${actor} is a code owner`);
    return;
  }

  // Check team membership
  for (const teamPath of teamPatterns) {
    const [org, team] = teamPath.split("/");
    try {
      const membership = await githubApi<TeamMembershipResponse>(
        `/orgs/${org}/teams/${team}/memberships/${actor}`,
        token,
      );
      if (membership) {
        core.info(`User ${actor} is a member of team @${teamPath}`);
        return;
      }
    } catch (e) {
      const error = e as Error & { message?: string };
      core.warning(`Could not check team membership for @${teamPath}: ${error.message}`);
    }
  }

  core.setFailed(`User ${actor} is not listed in CODEOWNERS`);
}

async function main() {
  const requiredPermission = process.env.REQUIRED_PERMISSION;
  if (!requiredPermission) {
    return core.setFailed("REQUIRED_PERMISSION not set");
  }

  if (requiredPermission === "any") return;

  const token = process.env.GH_TOKEN;
  if (!token) {
    return core.setFailed("GH_TOKEN not set");
  }

  const repository = process.env.GITHUB_REPOSITORY || "";
  const [owner = "", repo = ""] = repository.split("/");
  const actor =
    process.env.COMMENT_ACTOR || process.env.REVIEW_ACTOR || process.env.GITHUB_ACTOR || "";
  const ref = process.env.GITHUB_REF || "HEAD";

  if (!owner || !repo || !actor) {
    return core.setFailed("Missing required context (owner, repo, or actor)");
  }

  if (requiredPermission === "CODEOWNERS") {
    await checkCodeowners(owner, repo, ref, actor, token);
    return;
  }

  // Check collaborator permission level
  const data = await githubApi<{ permission: string }>(
    `/repos/${owner}/${repo}/collaborators/${actor}/permission`,
    token,
  );

  if (!data) {
    return core.setFailed(`Could not check permission for ${actor}`);
  }

  const permission = data.permission;

  if (requiredPermission === "admin") {
    if (permission !== "admin") {
      core.setFailed(`User ${actor} does not have admin permission (has: ${permission})`);
    }
  } else if (requiredPermission === "write") {
    if (permission !== "admin" && permission !== "write") {
      core.setFailed(`User ${actor} does not have write permission (has: ${permission})`);
    }
  } else {
    core.setFailed(
      `Unknown permission level: ${requiredPermission}. Use 'admin', 'write', 'any', or 'CODEOWNERS'`,
    );
  }
}

main().catch((error) => {
  core.setFailed(`Permission check failed: ${error}`);
});
