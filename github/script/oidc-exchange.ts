// Exchange a GitHub Actions OIDC token for a GitHub App installation token
// via Bonk's OIDC endpoint. Outputs the token (masked) to GH_TOKEN env var,
// or falls back to github.token when OIDC credentials aren't available.

import { getOidcToken, getApiBaseUrl, core } from "./context";
import { fetchWithRetry } from "./http";

async function main() {
  const fallbackToken = process.env.FALLBACK_TOKEN || "";
  const oidcUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const oidcToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!oidcUrl || !oidcToken) {
    core.warning("OIDC credentials not available (expected for fork PRs). Falling back to github.token.");
    maskValue(fallbackToken);
    appendToGithubEnv("GH_TOKEN", fallbackToken);
    core.setOutput("oidc_failed", "true");
    return;
  }

  // Get the OIDC token from GitHub Actions
  let actionOidcToken: string;
  try {
    actionOidcToken = await getOidcToken();
  } catch (error) {
    core.setFailed(`Failed to get OIDC token: ${error}`);
    return;
  }

  // Exchange for a GitHub App installation token via Bonk's endpoint
  const rawOidcBaseUrl = process.env.OIDC_BASE_URL;
  if (!rawOidcBaseUrl) {
    core.setFailed("OIDC_BASE_URL not set");
    return;
  }
  const oidcBaseUrl = rawOidcBaseUrl.replace(/\/+$/, "");

  let appToken: string;
  try {
    // Longer timeout: this is a multi-hop request (runner → worker → GitHub API)
    const resp = await fetchWithRetry(
      `${oidcBaseUrl}/exchange_github_app_token`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${actionOidcToken}`,
          "Content-Type": "application/json",
        },
      },
      { timeoutMs: 10000 },
    );

    if (!resp.ok) {
      const text = await resp.text();
      let errorMessage = "Unknown error";
      try {
        const data = JSON.parse(text) as { error?: string };
        errorMessage = data.error || errorMessage;
      } catch {
        errorMessage = text || errorMessage;
      }
      core.setFailed(`Failed to exchange OIDC token: ${errorMessage}`);
      return;
    }

    const data = (await resp.json()) as { token?: string };
    if (!data.token) {
      core.setFailed("OIDC token exchange response missing token.");
      return;
    }
    appToken = data.token;
  } catch (error) {
    core.setFailed(`OIDC token exchange failed: ${error}`);
    return;
  }

  maskValue(appToken);
  appendToGithubEnv("GH_TOKEN", appToken);
  core.setOutput("oidc_failed", "false");
}

function maskValue(value: string): void {
  if (value) {
    console.log(`::add-mask::${value}`);
  }
}

function appendToGithubEnv(name: string, value: string): void {
  const envFile = process.env.GITHUB_ENV;
  if (!envFile) {
    core.warning("GITHUB_ENV not set; cannot export environment variable");
    return;
  }
  const fs = require("fs");
  if (value.includes("\n")) {
    const delimiter = `BONK_${crypto.randomUUID().replace(/-/g, "")}`;
    fs.appendFileSync(envFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  } else {
    fs.appendFileSync(envFile, `${name}=${value}\n`);
  }
}

main().catch((error) => {
  core.setFailed(`Unexpected error: ${error}`);
});
