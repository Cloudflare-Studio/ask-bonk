// Runs a command with a short-lived installation token for another repository.

import { Buffer } from "buffer";
import { pathToFileURL } from "url";
import { getApiBaseUrl, getOidcToken } from "./context";
import { fetchWithRetry } from "./http";

function parseTarget(value: string | undefined): { owner: string; repo: string } {
  const parts = value?.split("/") || [];
  if (parts.length !== 2 || parts.some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part))) {
    throw new Error("Target repository must use owner/repo format");
  }
  return { owner: parts[0], repo: parts[1] };
}

async function forward(stream: ReadableStream<Uint8Array> | null, target: NodeJS.WriteStream) {
  if (!stream) return;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    target.write(value);
  }
}

async function exchangeToken(owner: string, repo: string): Promise<string> {
  const oidcToken = await getOidcToken();
  const response = await fetchWithRetry(
    `${getApiBaseUrl()}/auth/exchange_github_app_token_for_repo`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ owner, repo }),
    },
  );
  if (!response.ok) {
    throw new Error(`Cross-repository token exchange failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { token?: string };
  if (!data.token) throw new Error("Cross-repository token exchange returned no token");
  console.log(`::add-mask::${data.token}`);
  return data.token;
}

export async function runCrossRepoCommand(args = process.argv.slice(2)): Promise<number> {
  const separator = args.indexOf("--");
  if (separator !== 1 || args.length < 3) {
    console.error("Usage: cross-repo.ts owner/repo -- command [args...]");
    return 2;
  }

  const { owner, repo } = parseTarget(args[0]);
  const command = args.slice(separator + 1);
  if (command[0] !== "gh" && command[0] !== "git") {
    console.error("Cross-repository commands must run through gh or git");
    return 2;
  }
  const token = await exchangeToken(owner, repo);
  const basicAuth = Buffer.from(`x-access-token:${token}`).toString("base64");
  const proc = Bun.spawn(command, {
    env: {
      ...process.env,
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
      GH_REPO: `${owner}/${repo}`,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basicAuth}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await Promise.all([forward(proc.stdout, process.stdout), forward(proc.stderr, process.stderr)]);
  return await proc.exited;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(await runCrossRepoCommand());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
