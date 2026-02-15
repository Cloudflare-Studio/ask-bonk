// Exchange a GitHub Actions OIDC token for a GitHub App installation token
// via Bonk's OIDC endpoint. Outputs the token (masked) to GH_TOKEN env var,
// or falls back to github.token when OIDC is unavailable or fails.
//
// This step NEVER calls core.setFailed — it always succeeds and sets
// oidc_failed=true/false. The "Require OIDC" step in action.yml enforces
// that non-fork runs must have OIDC. For fork runs, oidc_failed=true is
// expected and the fork handler decides what to do.

import { getOidcToken, core } from "./context";
import { fetchWithRetry } from "./http";

function failWithFallback(reason: string): void {
  const fallbackToken = process.env.FALLBACK_TOKEN || "";
  core.warning(`OIDC exchange failed: ${reason}`);
  maskValue(fallbackToken);
  appendToGithubEnv("GH_TOKEN", fallbackToken);
  core.setOutput("oidc_failed", "true");
}

async function main() {
  const oidcUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const oidcRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!oidcUrl || !oidcRequestToken) {
    failWithFallback("OIDC credentials not available (expected for fork PRs)");
    return;
  }

  // Get the OIDC token from GitHub Actions
  let actionOidcToken: string;
  try {
    actionOidcToken = await getOidcToken();
  } catch (error) {
    failWithFallback(`Failed to get OIDC token: ${error}`);
    return;
  }

  // Exchange for a GitHub App installation token via Bonk's endpoint
  const rawOidcBaseUrl = process.env.OIDC_BASE_URL;
  if (!rawOidcBaseUrl) {
    failWithFallback("OIDC_BASE_URL not set");
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
      failWithFallback(`Token exchange returned ${resp.status}: ${errorMessage}`);
      return;
    }

    const data = (await resp.json()) as { token?: string };
    if (!data.token) {
      failWithFallback("Token exchange response missing token");
      return;
    }
    appToken = data.token;
  } catch (error) {
    failWithFallback(`Token exchange request failed: ${error}`);
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
  // Even unexpected errors should not kill the step — fall back gracefully.
  failWithFallback(`Unexpected error: ${error}`);
});
