import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { detectForkFromPR, parseTokenPermissions, checkPermissionLevel } from "../github/script/context";
import { fetchWithRetry } from "../github/script/http";

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
