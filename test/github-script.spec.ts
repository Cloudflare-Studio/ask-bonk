import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  detectForkFromPR,
  parseTokenPermissions,
  checkPermissionLevel,
  extractMentionPrompt,
  getApiBaseUrl,
} from "../github/script/context";
import { fetchWithRetry } from "../github/script/http";
import {
  buildPrompt,
  checkCodeowners,
  findMatchingCodeownersRule,
  parseCodeowners,
} from "../github/script/orchestrate";
import { isRetryableOpenCodeFailure } from "../github/script/run-opencode";

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("GitHub Action script context", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects forks from explicit head/base repos", async () => {
    await expect(
      detectForkFromPR("fork-owner/test-repo", "test-owner/test-repo", undefined, undefined),
    ).resolves.toEqual({ isFork: true });

    await expect(
      detectForkFromPR("test-owner/test-repo", "test-owner/test-repo", undefined, undefined),
    ).resolves.toEqual({ isFork: false });
  });

  it("falls back to fork mode when base repo is missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ head: { repo: { full_name: "fork/repo" }, sha: "abc" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await detectForkFromPR(
      undefined,
      undefined,
      "https://api.github.com/pr",
      "token",
    );
    expect(result).toEqual({ isFork: true, headSha: "abc" });
  });
});

describe("OIDC exchange permission forwarding", () => {
  // Tests parseTokenPermissions — the function orchestrate.ts uses to parse
  // the TOKEN_PERMISSIONS env var before forwarding to the exchange endpoint.

  it("parses JSON permissions object", () => {
    expect(parseTokenPermissions('{"contents": "read"}')).toEqual({ contents: "read" });
  });

  it("passes preset name through as a string", () => {
    expect(parseTokenPermissions("NO_PUSH")).toBe("NO_PUSH");
    expect(parseTokenPermissions("WRITE")).toBe("WRITE");
  });

  it("returns undefined for malformed JSON", () => {
    expect(parseTokenPermissions("{broken")).toBeUndefined();
  });

  it("returns undefined for empty/whitespace input", () => {
    expect(parseTokenPermissions("")).toBeUndefined();
    expect(parseTokenPermissions("  ")).toBeUndefined();
    expect(parseTokenPermissions(undefined)).toBeUndefined();
  });

  it("trims whitespace around preset names", () => {
    expect(parseTokenPermissions("  NO_PUSH  ")).toBe("NO_PUSH");
  });
});

describe("GitHub Action mention prompt extraction", () => {
  it("preserves the user's requested task from a Bonk mention", () => {
    expect(extractMentionPrompt("/bonk fix the flaky test", "/bonk,@ask-bonk")).toBe(
      "/bonk fix the flaky test",
    );
  });

  it("returns the bare-mention fallback", () => {
    expect(extractMentionPrompt("@ask-bonk", "/bonk,@ask-bonk")).toBe("Summarize this thread");
  });

  it("ignores comments without a configured mention", () => {
    expect(extractMentionPrompt("please fix this", "/bonk,@ask-bonk")).toBeNull();
  });
});

describe("GitHub Action preflight prompt", () => {
  it("preserves plain issue comment prompts", async () => {
    const result = await withEnv(
      {
        EVENT_NAME: "issue_comment",
        USER_PROMPT: undefined,
        COMMENT_BODY: "/bonk summarize this issue",
        REVIEW_BODY: undefined,
        MENTIONS: "/bonk,@ask-bonk",
        PR_NUMBER: undefined,
        ISSUE_NUMBER: "42",
        REPOSITORY: "owner/repo",
        PR_HEAD_REPO: undefined,
        PR_BASE_REPO: undefined,
        PR_URL: undefined,
        GH_TOKEN: undefined,
      },
      () => buildPrompt(),
    );

    expect(result).toEqual({
      isFork: false,
      detectionFailed: false,
      value: "/bonk summarize this issue",
    });
  });
});

describe("GitHub Action CODEOWNERS matching", () => {
  it("uses the last matching rule for changed files", () => {
    const rules = parseCodeowners(`
* @global-owner
/src/** @org/source-team
/src/generated/** @generated-owner
`);

    expect(findMatchingCodeownersRule(rules, "README.md")?.owners).toEqual(["global-owner"]);
    expect(findMatchingCodeownersRule(rules, "src/index.ts")?.teams).toEqual(["org/source-team"]);
    expect(findMatchingCodeownersRule(rules, "src/generated/client.ts")?.owners).toEqual([
      "generated-owner",
    ]);
  });

  it("preserves ownerless override rules", () => {
    const rules = parseCodeowners(`
/apps/ @alice
/apps/github
`);

    expect(findMatchingCodeownersRule(rules, "apps/github/action.ts")).toEqual({
      pattern: "/apps/github",
      owners: [],
      teams: [],
      unsupportedOwners: [],
      unsupportedPattern: false,
    });
  });

  it("matches unanchored directory patterns below any parent", () => {
    const rules = parseCodeowners("apps/ @alice");

    expect(findMatchingCodeownersRule(rules, "apps/index.ts")?.owners).toEqual(["alice"]);
    expect(findMatchingCodeownersRule(rules, "packages/apps/index.ts")?.owners).toEqual([
      "alice",
    ]);
  });

  it("keeps middle-slash directory patterns root-relative", () => {
    const rules = parseCodeowners(`
* @global-owner
build/logs/ @logs-owner
`);

    expect(findMatchingCodeownersRule(rules, "build/logs/a.txt")?.owners).toEqual([
      "logs-owner",
    ]);
    expect(findMatchingCodeownersRule(rules, "src/build/logs/a.txt")?.owners).toEqual([
      "global-owner",
    ]);
  });

  it("matches glob directory patterns below descendants", () => {
    const rules = parseCodeowners(`
* @global-owner
**/logs @logs-owner
`);

    expect(findMatchingCodeownersRule(rules, "logs/app.log")?.owners).toEqual(["logs-owner"]);
    expect(findMatchingCodeownersRule(rules, "build/logs/app.log")?.owners).toEqual([
      "logs-owner",
    ]);
  });

  it("keeps middle-slash patterns root-relative unless they use globstar", () => {
    const rules = parseCodeowners(`
* @global-owner
docs/* @docs-owner
`);

    expect(findMatchingCodeownersRule(rules, "docs/readme.md")?.owners).toEqual([
      "docs-owner",
    ]);
    expect(findMatchingCodeownersRule(rules, "packages/docs/readme.md")?.owners).toEqual([
      "global-owner",
    ]);
    expect(findMatchingCodeownersRule(rules, "docs/build-app/troubleshooting.md")?.owners).toEqual([
      "global-owner",
    ]);
  });

  it("matches globstar slash as zero or more directories", () => {
    const rules = parseCodeowners(`
* @global-owner
src/**/secrets.yml @security-owner
`);

    expect(findMatchingCodeownersRule(rules, "src/secrets.yml")?.owners).toEqual([
      "security-owner",
    ]);
    expect(findMatchingCodeownersRule(rules, "src/config/secrets.yml")?.owners).toEqual([
      "security-owner",
    ]);
  });

  it("keeps non-special double stars within a path segment", () => {
    const rules = parseCodeowners(`
* @global-owner
foo**bar @literal-owner
`);

    expect(findMatchingCodeownersRule(rules, "fooXXbar")?.owners).toEqual(["literal-owner"]);
    expect(findMatchingCodeownersRule(rules, "foo/x/bar")?.owners).toEqual(["global-owner"]);
  });

  it("parses escaped spaces in patterns", () => {
    const rules = parseCodeowners(`
* @global-owner
/docs/My\\ File.md @docs-owner
`);

    expect(findMatchingCodeownersRule(rules, "docs/My File.md")?.owners).toEqual([
      "docs-owner",
    ]);
  });

  it("parses escaped glob metacharacters as literals", () => {
    const rules = parseCodeowners(`
* @global-owner
/secrets/\\*.yml @literal-owner
`);

    expect(findMatchingCodeownersRule(rules, "secrets/*.yml")?.owners).toEqual([
      "literal-owner",
    ]);
    expect(findMatchingCodeownersRule(rules, "secrets/prod.yml")?.owners).toEqual([
      "global-owner",
    ]);
  });

  it("marks escaped leading hash rules unsupported", () => {
    const rules = parseCodeowners(`
* @global-owner
\\#secrets.yml @hash-owner
`);

    expect(rules[1]?.unsupportedPattern).toBe(true);
  });

  it("preserves unsupported owner tokens for fail-closed authorization", () => {
    const rules = parseCodeowners("src/** security@example.com");

    expect(findMatchingCodeownersRule(rules, "src/app.ts")?.unsupportedOwners).toEqual([
      "security@example.com",
    ]);
  });

  it("matches slashless literal directory patterns below descendants", () => {
    const rules = parseCodeowners(`
* @global-owner
src @src-owner
`);

    expect(findMatchingCodeownersRule(rules, "src/app.ts")?.owners).toEqual(["src-owner"]);
  });

  it("marks unescaped bracket patterns unsupported", () => {
    const rules = parseCodeowners(`
* @global-owner
/src/[ab].ts @src-owner
`);

    expect(findMatchingCodeownersRule(rules, "src/[ab].ts")?.unsupportedPattern).toBe(true);
  });

  it("keeps hash characters inside pattern fields", () => {
    const rules = parseCodeowners(`
* @global-owner
/docs/#private @private-owner
`);

    expect(findMatchingCodeownersRule(rules, "docs/#private")?.owners).toEqual([
      "private-owner",
    ]);
  });

  it("marks leading bang patterns unsupported", () => {
    const rules = parseCodeowners("!/secrets @security-owner");

    expect(rules[0]?.unsupportedPattern).toBe(true);
  });

  it("matches wildcard directory-like patterns below descendants", () => {
    const rules = parseCodeowners(`
* @global-owner
**/secret* @security-owner
`);

    expect(findMatchingCodeownersRule(rules, "src/secret-prod/key.yml")?.owners).toEqual([
      "security-owner",
    ]);
  });

  it("matches dotted wildcard directory-like patterns below descendants", () => {
    const rules = parseCodeowners(`
* @global-owner
**/config.* @security-owner
`);

    expect(findMatchingCodeownersRule(rules, "src/config.prod/key.yml")?.owners).toEqual([
      "security-owner",
    ]);
  });

  it("does not fall through empty higher-priority CODEOWNERS files", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ changed_files: 1, base: { sha: "base-sha" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ content: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ filename: "README.md" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(
      withEnv({ PR_NUMBER: "1", ISSUE_NUMBER: undefined }, () =>
        checkCodeowners("owner", "repo", "main", "alice", "token"),
      ),
    ).rejects.toThrow(
      "exit:1",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(exit).toHaveBeenCalledWith(1);
    fetchMock.mockRestore();
    exit.mockRestore();
  });

  it("dedupes repeated CODEOWNERS team groups before server verification", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ changed_files: 2, base: { sha: "base-sha" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ content: Buffer.from("src/** @org/security").toString("base64") }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ filename: "src/a.ts" }, { filename: "src/b.ts" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ permission: "write" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await expect(
      withEnv({ PR_NUMBER: "1", ISSUE_NUMBER: undefined }, () =>
        checkCodeowners("owner", "repo", "main", "alice", "token"),
      ),
    ).resolves.toEqual({ teamGroups: [["org/security"]] });
  });
});

describe("GitHub Action OIDC base URL", () => {
  it("normalizes the auth endpoint to the API base", () => {
    return withEnv({ OIDC_BASE_URL: "https://ask-bonk.example/auth/" }, () => {
      expect(getApiBaseUrl()).toBe("https://ask-bonk.example");
    });
  });

  it("rejects credentials, query strings, and fragments", async () => {
    await expect(
      withEnv({ OIDC_BASE_URL: "https://user:pass@ask-bonk.example/auth" }, () => getApiBaseUrl()),
    ).rejects.toThrow("must not include credentials");

    await expect(
      withEnv({ OIDC_BASE_URL: "https://ask-bonk.example/auth?token=1" }, () => getApiBaseUrl()),
    ).rejects.toThrow("must not include credentials");

    await expect(
      withEnv({ OIDC_BASE_URL: "https://ask-bonk.example/auth#frag" }, () => getApiBaseUrl()),
    ).rejects.toThrow("must not include credentials");

    await expect(
      withEnv({ OIDC_BASE_URL: "https://ask-bonk.example/auth?" }, () => getApiBaseUrl()),
    ).rejects.toThrow("must not include credentials");

    await expect(
      withEnv({ OIDC_BASE_URL: "https://ask-bonk.example/auth#" }, () => getApiBaseUrl()),
    ).rejects.toThrow("must not include credentials");
  });
});

// ---------------------------------------------------------------------------
// Permission Level Checking
// ---------------------------------------------------------------------------

describe("Permission level checking", () => {
  // Passing cases: actual permission meets or exceeds required level
  it.each([
    { actual: "admin", required: "admin", label: "admin satisfies admin" },
    { actual: "admin", required: "write", label: "admin satisfies write" },
    { actual: "write", required: "write", label: "write satisfies write" },
  ])("$label → passes", ({ actual, required }) => {
    expect(checkPermissionLevel(actual, required, "alice")).toBeNull();
  });

  // Failing cases: actual permission is below required level
  it.each([
    { actual: "write", required: "admin", label: "write does not satisfy admin" },
    { actual: "read", required: "admin", label: "read does not satisfy admin" },
    { actual: "read", required: "write", label: "read does not satisfy write" },
    { actual: "none", required: "write", label: "none does not satisfy write" },
    { actual: "none", required: "admin", label: "none does not satisfy admin" },
    { actual: "triage", required: "write", label: "triage does not satisfy write" },
    { actual: "maintain", required: "admin", label: "maintain does not satisfy admin" },
  ])("$label → fails with actor name in message", ({ actual, required }) => {
    const error = checkPermissionLevel(actual, required, "bob");
    expect(error).not.toBeNull();
    expect(error).toContain("bob");
    expect(error).toContain(required);
    expect(error).toContain(actual);
  });

  // Unknown permission levels that aren't in the recognized set ('admin', 'write')
  // are treated as insufficient — they get rank 0.
  it.each(["maintain", "triage", "read", "none", "unknown"])(
    "actual=%s is not recognized as admin or write level",
    (actual) => {
      expect(checkPermissionLevel(actual, "write", "alice")).not.toBeNull();
    },
  );

  // Unrecognized required levels return a specific error message
  it.each(["read", "maintain", "triage", "nonsense"])(
    "required=%s → unknown permission error",
    (required) => {
      const error = checkPermissionLevel("admin", required, "alice");
      expect(error).toContain("Unknown permission level");
      expect(error).toContain(required);
    },
  );
});

describe("GitHub Action script HTTP retry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries on transient failures", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("server error", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await fetchWithRetry(
      "https://example.com",
      { method: "GET" },
      { retries: 1, baseDelayMs: 1, timeoutMs: 1000 },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-transient status codes", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("bad request", { status: 400 }));

    const response = await fetchWithRetry(
      "https://example.com",
      { method: "GET" },
      { retries: 2, baseDelayMs: 1, timeoutMs: 1000 },
    );

    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("GitHub Action OpenCode retry classification", () => {
  it("retries transient OpenCode cancellation drops", () => {
    expect(
      isRetryableOpenCodeFailure({
        exitCode: 1,
        output: "Error: The operation was canceled.",
      }),
    ).toBe(true);
  });

  it("retries provider and network failures", () => {
    expect(
      isRetryableOpenCodeFailure({
        exitCode: 1,
        output: "provider stream terminated unexpectedly",
      }),
    ).toBe(true);

    expect(
      isRetryableOpenCodeFailure({
        exitCode: 1,
        output: "fetch failed: ECONNRESET",
      }),
    ).toBe(true);
  });

  it("does not retry GitHub cancellation or timeout exits", () => {
    expect(
      isRetryableOpenCodeFailure({
        exitCode: 143,
        output: "Error: The operation was canceled.",
      }),
    ).toBe(false);

    expect(
      isRetryableOpenCodeFailure({
        exitCode: 124,
        output: "Error: The operation was canceled.",
      }),
    ).toBe(false);

    expect(
      isRetryableOpenCodeFailure({
        exitCode: 1,
        output: "The operation was canceled because the workflow was cancelled.",
      }),
    ).toBe(false);
  });

  it("does not retry ordinary command failures", () => {
    expect(
      isRetryableOpenCodeFailure({
        exitCode: 1,
        output: "TypeScript compilation failed",
      }),
    ).toBe(false);
  });
});
