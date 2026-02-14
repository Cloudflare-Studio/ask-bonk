// Resolve the opencode version for cache keying.
// Uses the GitHub API to fetch the latest release tag or dev commit SHA.

import { core } from "./context";
import { fetchWithRetry } from "./http";

const OPENCODE_REPO = "anomalyco/opencode";

async function main() {
  const isDev = process.env.OPENCODE_DEV === "true";
  const ghToken = process.env.GH_TOKEN || "";
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  if (ghToken) {
    headers.Authorization = `Bearer ${ghToken}`;
  }

  if (isDev) {
    let version = "dev";
    try {
      const resp = await fetchWithRetry(
        `https://api.github.com/repos/${OPENCODE_REPO}/commits/dev`,
        { headers },
      );
      if (resp.ok) {
        const data = (await resp.json()) as { sha?: string };
        if (data.sha) {
          version = data.sha.slice(0, 7);
        }
      }
    } catch {
      // Fall back to "dev" if the API is unavailable
    }
    core.setOutput("version", `dev-${version}`);
    core.setOutput("dev", "true");
    // "dev" is a valid fallback — still busts cache on each run
    core.setOutput("cacheable", "true");
  } else {
    let version = "latest";
    try {
      const resp = await fetchWithRetry(
        `https://api.github.com/repos/${OPENCODE_REPO}/releases/latest`,
        { headers },
      );
      if (resp.ok) {
        const data = (await resp.json()) as { tag_name?: string };
        if (data.tag_name) {
          version = data.tag_name;
        }
      }
    } catch {
      // Fall back to "latest" if the API is unavailable
    }
    core.setOutput("version", version);
    core.setOutput("dev", "false");
    // Skip caching when version is "latest" — the key never busts on new releases
    core.setOutput("cacheable", version !== "latest" ? "true" : "false");
  }
}

main().catch((error) => {
  core.warning(`Failed to get opencode version: ${error}`);
  core.setOutput("version", process.env.OPENCODE_DEV === "true" ? "dev-dev" : "latest");
  core.setOutput("dev", process.env.OPENCODE_DEV === "true" ? "true" : "false");
  core.setOutput("cacheable", "false");
});
