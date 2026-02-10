/**
 * GitHub API helpers for the Bonk CLI
 * Uses the gh CLI for all operations
 */

import { execSync, spawnSync } from "child_process";

const OIDC_BASE_URL = "https://ask-bonk.silverlock.workers.dev/auth";

export function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function getGitOrigin(): string | null {
  try {
    const result = execSync("git remote get-url origin", {
      encoding: "utf-8",
    }).trim();
    const match = result.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (match) {
      return `${match[1]}/${match[2]}`;
    }
  } catch {
    // Not a git repo or no origin
  }
  return null;
}

export function isGhAuthenticated(): boolean {
  try {
    execSync("gh auth status", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function hasWorkflowScope(): boolean {
  try {
    const result = execSync("gh auth status 2>&1", { encoding: "utf-8" });
    return result.includes("workflow");
  } catch {
    return false;
  }
}

export function repoExists(repo: string): boolean {
  try {
    execSync(`gh api repos/${repo}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function setSecret(repo: string, name: string, value: string): boolean {
  try {
    const result = spawnSync("gh", ["secret", "set", name, "-R", repo], {
      input: value,
      encoding: "utf-8",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function getDefaultBranch(repo: string): string {
  try {
    const result = execSync(`gh api repos/${repo} --jq '.default_branch'`, {
      encoding: "utf-8",
    });
    return result.trim();
  } catch {
    return "main";
  }
}

export function branchExists(repo: string, branch: string): boolean {
  try {
    execSync(`gh api repos/${repo}/git/ref/heads/${branch}`, {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function createBranch(repo: string, branch: string, baseBranch: string): boolean {
  try {
    const sha = execSync(`gh api repos/${repo}/git/ref/heads/${baseBranch} --jq '.object.sha'`, {
      encoding: "utf-8",
    }).trim();
    execSync(`gh api repos/${repo}/git/refs -f ref=refs/heads/${branch} -f sha=${sha}`, {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function getFileSha(repo: string, path: string, branch: string): string | null {
  try {
    const result = execSync(`gh api repos/${repo}/contents/${path}?ref=${branch} --jq '.sha'`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

export function createFile(
  repo: string,
  path: string,
  content: string,
  message: string,
  branch: string,
): boolean {
  try {
    const base64Content = Buffer.from(content).toString("base64");
    const existingSha = getFileSha(repo, path, branch);

    const args = [
      "api",
      `repos/${repo}/contents/${path}`,
      "-X",
      "PUT",
      "-f",
      `message=${message}`,
      "-f",
      `content=${base64Content}`,
      "-f",
      `branch=${branch}`,
    ];

    if (existingSha) {
      args.push("-f", `sha=${existingSha}`);
    }

    const result = spawnSync("gh", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    return result.status === 0;
  } catch {
    return false;
  }
}

export function createPR(
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string,
): string | null {
  try {
    const result = spawnSync(
      "gh",
      ["pr", "create", "-R", repo, "-H", head, "-B", base, "-t", title, "-F", "-"],
      {
        input: body,
        encoding: "utf-8",
      },
    );
    if (result.status !== 0) {
      return null;
    }
    return result.stdout.trim();
  } catch {
    return null;
  }
}

export function findExistingPR(repo: string, branch: string): string | null {
  try {
    const result = execSync(`gh pr list -R ${repo} -H ${branch} --json url --jq '.[0].url'`, {
      encoding: "utf-8",
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

export function workflowExists(repo: string, path: string): boolean {
  try {
    execSync(`gh api repos/${repo}/contents/${path}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function checkAppInstallation(repo: string): Promise<boolean> {
  try {
    const [owner, repoName] = repo.split("/");
    const response = await fetch(
      `${OIDC_BASE_URL}/get_github_app_installation?owner=${owner}&repo=${repoName}`,
    );
    if (!response.ok) return false;
    const data = (await response.json()) as {
      installation: { id: number } | null;
    };
    return data.installation !== null;
  } catch {
    return false;
  }
}

export async function waitForAppInstallation(repo: string, maxRetries = 12): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    if (await checkAppInstallation(repo)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  return false;
}

export function openUrl(url: string): boolean {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      execSync(`open "${url}"`);
    } else if (platform === "win32") {
      execSync(`start "" "${url}"`);
    } else {
      execSync(`xdg-open "${url}"`);
    }
    return true;
  } catch {
    return false;
  }
}
