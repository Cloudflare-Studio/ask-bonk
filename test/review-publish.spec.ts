import { mkdirSync, rmSync, writeFileSync } from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  anchorFinding,
  applySeverityRules,
  buildStickyBody,
  computeVerdict,
  stripVerdict,
  isReviewRun,
  parseCommentableLines,
  partitionFindings,
  parseReviewFile,
  publishReview,
  type BonkThread,
  type Finding,
} from "../github/script/review-publish";
import { isTestPath, writeDiff } from "../github/script/review-diff";
import { checkReviewCompletion } from "../github/script/run-opencode";
import {
  findStickyComment,
  formatReviewStateMarker,
  parseReviewStateMarker,
} from "../github/script/review-state";

const OLD_HEAD = "a".repeat(40);
const HEAD = "b".repeat(40);
const NEW_HEAD = "f".repeat(40);
const BASE = "c".repeat(40);
const bonk = { __typename: "Bot", login: "ask-bonk" };
const human = { __typename: "User", login: "alice" };

async function withEnv<T>(
  values: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Two hunks: new lines 10-12 (11 added) and new lines 40-41 (41 added, old 38 removed).
const PATCH = "@@ -10,2 +10,3 @@\n a\n+b\n c\n@@ -38,2 +40,2 @@\n x\n-y\n+z";

interface Request {
  method: string;
  url: string;
  body?: unknown;
}

function mockGitHub(pullRequest: Record<string, unknown>, reviewStatus = 200): Request[] {
  const requests: Request[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    requests.push({ method, url, body });
    if (url === "https://api.github.com/graphql") {
      return jsonResponse({
        data: { viewer: { login: "ask-bonk[bot]" }, repository: { pullRequest } },
      });
    }
    if (url.includes("/pulls/5/files")) {
      return jsonResponse([{ filename: "src/a.ts", patch: PATCH }]);
    }
    if (url.endsWith("/pulls/5/reviews")) return jsonResponse({}, reviewStatus);
    return jsonResponse({});
  });
  return requests;
}

// A review thread as the paged threads query returns it.
function thread(id: string, line: number, authors: Array<typeof bonk>) {
  const comments = authors.map((author, index) => ({ id: `${id}-${index}`, author, body: "x" }));
  return {
    id,
    isResolved: false,
    path: "src/a.ts",
    line,
    first: { nodes: comments.slice(0, 1) },
    recent: { totalCount: comments.length, nodes: comments },
  };
}

function patchedBody(request: Request | undefined): string {
  return (request?.body as { body?: string } | undefined)?.body ?? "";
}

function writeReviewFile(name: string, content: unknown): string {
  mkdirSync("/tmp/bonk-test", { recursive: true });
  const path = `/tmp/bonk-test/${name}.json`;
  writeFileSync(path, JSON.stringify(content));
  return path;
}

function publishEnv(
  reviewFile: string,
  extra: Record<string, string | undefined> = {},
  changedFiles: string[] | null = null,
) {
  return {
    GH_TOKEN: "token",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_SERVER_URL: "https://github.com",
    PR_NUMBER: "5",
    GITHUB_RUN_ID: "100",
    EVENT_NAME: "issue_comment",
    WORKSPACE_HEAD_SHA: HEAD,
    REVIEW_STATE: JSON.stringify({
      head: HEAD,
      base: BASE,
      lastReviewId: 3,
      changedFiles,
      reviewFile,
    }),
    ...extra,
  };
}

const stickyComment = {
  databaseId: 10,
  author: bonk,
  body: `Review: 1 findings.\n\n---\n<sub>Reviewed commit</sub>\n\n${formatReviewStateMarker({ head: OLD_HEAD, base: BASE })}`,
};

function response(text: string) {
  return {
    databaseId: 11,
    author: bonk,
    body: `${text}\n\n[github run](/owner/repo/actions/runs/100)`,
  };
}

describe("Bonk review publishing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps only well-formed findings from the model's review file", () => {
    expect(parseReviewFile("not json")).toBeNull();
    expect(parseReviewFile("[]")).toBeNull();
    expect(
      parseReviewFile(
        JSON.stringify({
          findings: [
            { path: "src/a.ts", line: 11, body: "Bug", severity: "BLOCKING" },
            {
              path: "src/a.ts",
              line: 12,
              start_line: 10,
              side: "LEFT",
              body: "Range",
              severity: "info",
              justified: true,
              quote: { path: "AGENTS.md", text: "Use KJ types" },
            },
            { path: "src/a.ts", line: 0, body: "Line zero is about the file", severity: "nit" },
            { body: "About the whole change", severity: "question" },
            { path: "src/a.ts", line: 3, body: "  " },
            "garbage",
          ],
          thread_actions: [
            { thread_id: "PRRT_1", action: "resolve", body: "Fixed in bbbbbbbb: added the check." },
            { thread_id: "PRRT_2", action: "unresolve" },
            { thread_id: "PRRT_3", action: "reply" },
            { thread_id: "PRRT_4", action: "delete", body: "x" },
            { action: "resolve" },
          ],
        }),
      ),
    ).toEqual({
      findings: [
        { path: "src/a.ts", line: 11, side: "RIGHT", body: "Bug", severity: "blocking" },
        {
          path: "src/a.ts",
          line: 12,
          startLine: 10,
          side: "LEFT",
          body: "Range",
          severity: "info",
          justified: true,
          quote: { path: "AGENTS.md", text: "Use KJ types" },
        },
        // Unknown severities count as warnings.
        {
          path: "src/a.ts",
          side: "RIGHT",
          body: "Line zero is about the file",
          severity: "warning",
        },
        { path: "", side: "RIGHT", body: "About the whole change", severity: "question" },
      ],
      threadActions: [
        { threadId: "PRRT_1", action: "resolve", body: "Fixed in bbbbbbbb: added the check." },
        { threadId: "PRRT_2", action: "unresolve" },
      ],
    });
  });

  it("anchors findings to commentable diff lines", () => {
    const lines = parseCommentableLines([{ filename: "src/a.ts", patch: PATCH }]);
    const finding = (overrides: Partial<Finding>): Finding => ({
      path: "src/a.ts",
      line: 11,
      side: "RIGHT",
      body: "Bug",
      severity: "warning",
      ...overrides,
    });

    expect(anchorFinding(finding({}), lines)).toEqual(finding({}));
    expect(anchorFinding(finding({ line: 39, side: "LEFT" }), lines)).toEqual(
      finding({ line: 39, side: "LEFT" }),
    );
    // Snaps to the nearest commentable line within five lines.
    expect(anchorFinding(finding({ line: 16 }), lines)?.line).toBe(12);
    expect(anchorFinding(finding({ line: 30 }), lines)).toBeNull();
    // Suggestions replace exactly the lines they target, so they never move.
    expect(anchorFinding(finding({ line: 16, body: "```suggestion\nx\n```" }), lines)).toBeNull();
    // A range must stay within one hunk.
    expect(anchorFinding(finding({ line: 40, startLine: 12 }), lines)).toBeNull();
    expect(anchorFinding(finding({ path: "src/other.ts" }), lines)).toBeNull();
  });

  it("matches findings to Bonk's threads by id and never drops a finding", () => {
    const thread = (id: string, overrides: Partial<BonkThread>): BonkThread => ({
      id,
      resolved: false,
      path: "src/a.ts",
      line: 20,
      hasHumanReplies: false,
      body: "Old finding",
      ...overrides,
    });
    const threads = [
      thread("open", { line: 20 }),
      thread("resolved", { line: 60, resolved: true }),
      thread("stale", { line: 90 }),
      thread("answered", { line: 120, hasHumanReplies: true }),
      thread("acted", { line: 150 }),
      thread("untouched-file", { path: "src/b.ts" }),
    ];
    const finding = (line: number, overrides: Partial<Finding> = {}): Finding => ({
      path: "src/a.ts",
      line,
      side: "RIGHT",
      body: "New defect",
      severity: "warning",
      ...overrides,
    });

    const reReported = finding(24, { threadId: "open", body: "Old finding, still there" });
    const stillPresent = finding(61, { threadId: "resolved", body: "Old finding" });
    // Distinct defects next to an open and a resolved thread, without ids.
    const nearOpen = finding(22);
    const nearResolved = finding(60);
    const unknownId = finding(300, { threadId: "PRRT_elsewhere" });
    const result = partitionFindings(
      [reReported, stillPresent, nearOpen, nearResolved, unknownId],
      threads,
      new Set(["acted"]),
      ["src/a.ts"],
    );
    expect(result.toPost).toEqual([nearOpen, nearResolved, unknownId]);
    expect(result.kept.map((entry) => entry.id)).toEqual(["open"]);
    expect(result.stillPresent.map((entry) => entry.thread.id)).toEqual(["resolved"]);
    // "stale" has no finding referencing it, no replies, and its file changed.
    expect(result.toResolve.map((entry) => entry.id)).toEqual(["stale"]);

    // Without an id, only a verbatim copy on the same line counts as the thread's finding.
    const copy = partitionFindings([finding(20, { body: " old  FINDING " })], threads, new Set(), [
      "src/a.ts",
    ]);
    expect(copy.toPost).toEqual([]);
    expect(copy.kept.map((entry) => entry.id)).toEqual(["open"]);

    // A full review may resolve unreferenced threads in any file.
    expect(
      partitionFindings([], threads, new Set(), null).toResolve.map((entry) => entry.id),
    ).toEqual(["open", "stale", "acted", "untouched-file"]);
  });

  it("applies the severity rules in code", () => {
    mkdirSync("/tmp/bonk-test/repo/docs", { recursive: true });
    writeFileSync(
      "/tmp/bonk-test/repo/docs/style.md",
      "Rules:\nPrefer kj::Maybe over\n  nullable pointers.\n",
    );
    const finding = (overrides: Partial<Finding>): Finding => ({
      path: "src/a.c++",
      line: 3,
      side: "RIGHT",
      body: "x",
      severity: "blocking",
      ...overrides,
    });

    const result = applySeverityRules(
      [
        finding({}),
        finding({ path: "src/a-test.c++" }),
        finding({ path: "src/tests/a.js", justified: true }),
        finding({ path: "test/b.spec.ts", severity: "info", justified: true }),
        finding({ severity: "question" }),
        finding({ severity: "question" }),
        finding({
          quote: { path: "docs/style.md", text: "Prefer kj::Maybe over nullable pointers." },
        }),
        finding({ quote: { path: "docs/style.md", text: "Always use kj::Maybe." } }),
        finding({ quote: { path: "../outside.md", text: "Rules:" } }),
      ],
      "/tmp/bonk-test/repo",
    );
    expect(result.map((entry) => entry.severity)).toEqual([
      "blocking",
      // One level down in a test file, one more when justified, never below suggestion.
      "warning",
      "info",
      "suggestion",
      // At most one question per review.
      "question",
      "info",
      "blocking",
      "blocking",
      "blocking",
    ]);
    // Quotes must appear verbatim (modulo whitespace) in a repository file.
    expect(result.map((entry) => Boolean(entry.quote))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(isTestPath("src/workerd/api/tests/url-test.wd-test")).toBe(true);
    expect(isTestPath("src/workerd/api/url.c++")).toBe(false);
  });

  it("computes the verdict from the findings", () => {
    const finding = (severity: Finding["severity"]): Finding => ({
      path: "src/a.ts",
      line: 1,
      side: "RIGHT",
      body: "x",
      severity,
    });
    expect(computeVerdict({ findings: [] }, false)).toBe("LGTM!");
    expect(
      computeVerdict(
        { findings: [finding("blocking"), finding("warning"), finding("warning")] },
        false,
      ),
    ).toBe("Review: 3 findings (1 blocking, 2 warnings).");
    expect(computeVerdict({ findings: [finding("info")] }, false)).toBe(
      "Review: 1 finding (1 info).",
    );
    expect(computeVerdict({ findings: [], resolved: 2, stillOpen: 0, added: 0 }, true)).toBe(
      "Since last review: 2 resolved, 0 still open, 0 new.\nLGTM!",
    );
    expect(
      computeVerdict({ findings: [finding("warning")], resolved: 1, stillOpen: 1, added: 0 }, true),
    ).toBe("Since last review: 1 resolved, 1 still open, 0 new.");
    expect(
      stripVerdict("Since last review: 0 resolved, 0 still open, 0 new.\nLGTM!\n\nNotes."),
    ).toBe("Notes.");
    expect(stripVerdict("Review: 2 findings.\nI'm Bonk.")).toBe("I'm Bonk.");
  });

  it("recognizes review runs", () => {
    expect(isReviewRun("issue_comment", 5, [5], "Here is an answer.", true)).toBe(true);
    expect(isReviewRun("pull_request", 5, [], "Found two issues.")).toBe(true);
    expect(isReviewRun("issue_comment", 5, [5, 6], "Posted 1 inline finding.")).toBe(true);
    expect(isReviewRun("issue_comment", 5, [5], "LGTM!")).toBe(true);
    expect(isReviewRun("issue_comment", 5, [5], "LGTM")).toBe(true);
    expect(isReviewRun("issue_comment", 5, [5], "Review: 2 findings.\n\n1. **P1:** ...")).toBe(
      true,
    );
    expect(isReviewRun("issue_comment", 5, [5], "Review: 2 findings (2 warnings).")).toBe(true);
    expect(
      isReviewRun("issue_comment", 5, [5], "Since last review: 1 resolved, 0 still open, 0 new."),
    ).toBe(true);
    expect(isReviewRun("issue_comment", 5, [5], "The auth flow works like this: ...")).toBe(false);
    expect(isReviewRun("issue_comment", 5, [5], "LGTMs are cheap; here is how retries work.")).toBe(
      false,
    );
    expect(isReviewRun("issue_comment", 5, [5], "I'm Bonk. Review: 2 findings.")).toBe(false);
  });

  it("builds the sticky body with the reviewed commit and marker last", () => {
    const body = buildStickyBody({
      summary: "LGTM!",
      unanchored: "",
      head: HEAD,
      base: BASE,
      liveHead: HEAD,
      stale: false,
      commitUrl: `https://github.com/owner/repo/commit/${HEAD}`,
      runUrl: "https://github.com/owner/repo/actions/runs/100",
    });
    expect(body.startsWith("LGTM!\n\n---\n<sub>Reviewed commit: [bbbbbbbb]")).toBe(true);
    expect(body.endsWith(formatReviewStateMarker({ head: HEAD, base: BASE }))).toBe(true);
  });

  it("posts findings in an empty-body review and folds the response into the sticky comment", async () => {
    const requests = mockGitHub({
      headRefOid: HEAD,
      comments: {
        nodes: [stickyComment, { author: human, body: "thanks" }, response("Review: 2 findings.")],
      },
      reviews: { nodes: [{ databaseId: 3, author: bonk }] },
    });
    const reviewFile = writeReviewFile("sticky", {
      findings: [
        { path: "src/a.ts", line: 11, body: "Null deref", severity: "blocking" },
        { path: "docs/missing.md", line: 1, body: "Document the flag", severity: "warning" },
        { path: "src/a.ts", line: 12, body: "Consider a clearer name", severity: "suggestion" },
      ],
    });

    await withEnv(publishEnv(reviewFile), () => publishReview());

    const review = requests.find((request) => request.url.endsWith("/pulls/5/reviews"));
    expect(review?.body).toEqual({
      commit_id: HEAD,
      event: "COMMENT",
      body: "",
      comments: [{ path: "src/a.ts", line: 11, side: "RIGHT", body: "**[BLOCKING]** Null deref" }],
    });

    const patch = requests.find((request) => request.method === "PATCH");
    expect(patch?.url).toBe("https://api.github.com/repos/owner/repo/issues/comments/10");
    const body = patchedBody(patch);
    // The verdict is computed from the findings; the model's line is replaced.
    expect(body.startsWith("Review: 3 findings (1 blocking, 1 warning, 1 suggestion).\n\n")).toBe(
      true,
    );
    expect(body).not.toContain("Review: 2 findings.");
    expect(body).toContain(
      "**Findings outside the diff**\n\n- **[WARNING]** `docs/missing.md:1`: Document the flag",
    );
    // Suggestions are summary-only.
    expect(body).toContain(
      "**Other findings**\n\n- **[SUGGESTION]** `src/a.ts:12`: Consider a clearer name",
    );
    expect(body).not.toContain("[github run](/owner/repo/actions/runs/100)\n");
    expect(parseReviewStateMarker(body)).toEqual({ head: HEAD, base: BASE });

    const deleted = requests.find((request) => request.method === "DELETE");
    expect(deleted?.url).toBe("https://api.github.com/repos/owner/repo/issues/comments/11");
  });

  it("places comments on the same hunks the prompt showed", async () => {
    const diffDir = `/tmp/bonk-test/diff-${crypto.randomUUID()}`;
    writeDiff(
      diffDir,
      [
        {
          filename: "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "@@ -70 +70,2 @@\n x\n+y",
        },
      ],
      [],
      false,
    );
    const requests = mockGitHub({
      headRefOid: HEAD,
      comments: { nodes: [response("Review: 1 findings.")] },
    });
    const reviewFile = writeReviewFile("manifest", {
      findings: [{ path: "src/a.ts", line: 71, body: "Bug", severity: "warning" }],
    });
    const env = publishEnv(reviewFile);
    const state = { ...JSON.parse(env.REVIEW_STATE), diffDir };

    await withEnv({ ...env, REVIEW_STATE: JSON.stringify(state) }, () => publishReview());

    expect(requests.some((request) => request.url.includes("/pulls/5/files"))).toBe(false);
    const review = requests.find((request) => request.url.endsWith("/pulls/5/reviews"));
    expect((review?.body as { comments?: unknown[] } | undefined)?.comments).toEqual([
      { path: "src/a.ts", line: 71, side: "RIGHT", body: "**[WARNING]** Bug" },
    ]);
  });

  it("keeps findings visible when the pull request moved or GitHub rejects the review", async () => {
    const findings = { findings: [{ path: "src/a.ts", line: 11, body: "Null deref" }] };

    let requests = mockGitHub({
      headRefOid: NEW_HEAD,
      comments: { nodes: [response("Review: 1 findings.")] },
      reviews: { nodes: [] },
    });
    await withEnv(publishEnv(writeReviewFile("stale", findings)), () => publishReview());
    expect(requests.some((request) => request.url.endsWith("/pulls/5/reviews"))).toBe(false);
    let patch = requests.find((request) => request.method === "PATCH");
    // Without an earlier sticky comment, this run's response becomes it.
    expect(patch?.url).toBe("https://api.github.com/repos/owner/repo/issues/comments/11");
    let body = patchedBody(patch);
    expect(body).toContain("Findings not posted inline because the pull request changed");
    expect(body).toContain("the pull request head has since moved to ffffffffffff");
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);

    vi.restoreAllMocks();
    requests = mockGitHub(
      {
        headRefOid: HEAD,
        comments: { nodes: [response("Review: 1 findings.")] },
        reviews: { nodes: [] },
      },
      422,
    );
    await withEnv(publishEnv(writeReviewFile("rejected", findings)), () => publishReview());
    patch = requests.find((request) => request.method === "PATCH");
    body = patchedBody(patch);
    expect(body).toContain("- **[WARNING]** `src/a.ts:11`: Null deref");
  });

  it("follows up on Bonk's own threads and never on anyone else's", async () => {
    const requests = mockGitHub({
      headRefOid: HEAD,
      comments: {
        nodes: [stickyComment, response("Since last review: 1 resolved, 1 still open, 0 new.")],
      },
      reviews: { nodes: [{ databaseId: 3, author: bonk }] },
      reviewThreads: {
        nodes: [
          thread("PRRT_fixed", 11, [bonk]),
          thread("PRRT_open", 40, [bonk]),
          thread("PRRT_gone", 90, [bonk]),
          thread("PRRT_discussed", 120, [bonk, human]),
          thread("PRRT_human", 5, [human]),
        ],
      },
    });
    const reviewFile = writeReviewFile("threads", {
      findings: [{ path: "src/a.ts", line: 41, body: "Still leaks", thread_id: "PRRT_open" }],
      thread_actions: [
        {
          thread_id: "PRRT_fixed",
          action: "resolve",
          body: "Fixed in bbbbbbbb: added the null check.",
        },
        { thread_id: "PRRT_human", action: "resolve", body: "Done." },
      ],
    });

    await withEnv(publishEnv(reviewFile, {}, ["src/a.ts"]), () => publishReview());

    const mutations = requests
      .filter((request) => request.url.endsWith("/graphql"))
      .map((request) => request.body as { query: string; variables: Record<string, string> })
      .filter((body) => body.query.trimStart().startsWith("mutation"))
      .map(
        (body) =>
          `${body.query.match(/(addPullRequestReviewThreadReply|resolveReviewThread|unresolveReviewThread)/)?.[1]} ${body.variables.id}${body.variables.body ? ` ${body.variables.body}` : ""}`,
      );
    expect(mutations).toEqual([
      "addPullRequestReviewThreadReply PRRT_fixed Fixed in bbbbbbbb: added the null check.",
      "resolveReviewThread PRRT_fixed",
      // No finding matches it, nobody replied, and its file changed.
      "resolveReviewThread PRRT_gone",
    ]);
    // The still-open finding names its thread and is not posted again.
    expect(requests.some((request) => request.url.endsWith("/pulls/5/reviews"))).toBe(false);
  });

  it("posts a new defect next to an earlier thread instead of folding it in", async () => {
    // A distinct defect two lines from an open Bonk thread and one line from a
    // resolved one, reported without a thread id.
    const requests = mockGitHub({
      headRefOid: HEAD,
      comments: { nodes: [stickyComment, response("Review: 1 findings.")] },
      reviews: { nodes: [{ databaseId: 3, author: bonk }] },
      reviewThreads: {
        nodes: [
          thread("PRRT_open", 40, [bonk]),
          { ...thread("PRRT_done", 12, [bonk]), isResolved: true },
        ],
      },
    });
    const reviewFile = writeReviewFile("nearby", {
      findings: [
        { path: "src/a.ts", line: 41, body: "Off-by-one in the new loop bound" },
        { path: "src/a.ts", line: 11, body: "Unchecked null in the new branch" },
        { path: "src/a.ts", line: 40, body: "x", thread_id: "PRRT_open" },
        { path: "src/a.ts", line: 12, body: "Still unchecked", thread_id: "PRRT_done" },
      ],
    });

    await withEnv(publishEnv(reviewFile, {}, ["src/a.ts"]), () => publishReview());

    const review = requests.find((request) => request.url.endsWith("/pulls/5/reviews"));
    const posted = review?.body as { comments?: Array<{ line: number; body: string }> } | undefined;
    expect(posted?.comments).toEqual([
      expect.objectContaining({ line: 41, body: "**[WARNING]** Off-by-one in the new loop bound" }),
      expect.objectContaining({ line: 11, body: "**[WARNING]** Unchecked null in the new branch" }),
    ]);
    // The re-reported finding keeps its thread, so nothing resolves it.
    const mutations = requests.filter(
      (request) =>
        request.url.endsWith("/graphql") &&
        String((request.body as { query: string }).query)
          .trimStart()
          .startsWith("mutation"),
    );
    expect(mutations).toEqual([]);
    // A re-reported finding on a resolved thread stays visible in the summary.
    expect(patchedBody(requests.find((request) => request.method === "PATCH"))).toContain(
      "**Earlier findings still present (thread resolved)**\n\n- **[WARNING]** `src/a.ts:12`: Still unchecked",
    );
  });

  it("pages back through comments to find the sticky summary", async () => {
    const befores: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const { variables } = JSON.parse(String(init?.body)) as { variables: { before: unknown } };
      befores.push(variables.before);
      const older = variables.before === "cursor-1";
      return jsonResponse({
        data: {
          repository: {
            pullRequest: {
              comments: {
                nodes: older ? [stickyComment] : [{ databaseId: 50, author: human, body: "ping" }],
                pageInfo: { hasPreviousPage: !older, startCursor: "cursor-1" },
              },
            },
          },
        },
      });
    });

    const sticky = await findStickyComment("token", "owner/repo", "5", "ask-bonk");
    expect(sticky?.databaseId).toBe(10);
    expect(befores).toEqual([null, "cursor-1"]);
  });

  it.each([
    { label: "a findings file", file: true, text: "Here you go.", complete: true },
    { label: "a verdict line", file: false, text: "LGTM", complete: true },
    { label: "neither", file: false, text: "I looked at the diff and", complete: false },
  ])("treats a review run with $label as complete: $complete", async ({ file, text, complete }) => {
    const path = "/tmp/bonk-test/completion.json";
    try {
      rmSync(path);
    } catch {
      // Not there yet.
    }
    if (file) writeReviewFile("completion", { findings: [] });
    const requests = mockGitHub({ comments: { nodes: [response(text)] } });
    const env = publishEnv(path);
    const state = { ...JSON.parse(env.REVIEW_STATE), expectReview: true };

    const result = await withEnv({ ...env, REVIEW_STATE: JSON.stringify(state) }, () =>
      checkReviewCompletion(),
    );

    expect(result).toBe(complete);
    // A failed attempt's text is removed so it never stands in for a review.
    const deleted = requests.filter((request) => request.method === "DELETE");
    expect(deleted.map((request) => request.url)).toEqual(
      complete ? [] : ["https://api.github.com/repos/owner/repo/issues/comments/11"],
    );
  });

  it("does not check answers to requests that were not reviews", async () => {
    const requests = mockGitHub({ comments: { nodes: [response("It retries three times.")] } });
    await expect(
      withEnv(publishEnv("/tmp/bonk-test/absent.json"), () => checkReviewCompletion()),
    ).resolves.toBe(true);
    expect(requests).toEqual([]);
  });

  it("never publishes a review run that produced no review", async () => {
    const requests = mockGitHub({
      headRefOid: HEAD,
      comments: { nodes: [stickyComment, response("I looked at the diff and")] },
      reviews: { nodes: [] },
    });
    const env = publishEnv("/tmp/bonk-test/absent.json", { EVENT_NAME: "pull_request" });
    const state = { ...JSON.parse(env.REVIEW_STATE), expectReview: true };

    await withEnv({ ...env, REVIEW_STATE: JSON.stringify(state) }, () => publishReview());

    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("leaves non-review answers as normal comments", async () => {
    const requests = mockGitHub({
      headRefOid: HEAD,
      comments: { nodes: [stickyComment, response("It retries three times.")] },
      reviews: { nodes: [{ databaseId: 3, author: bonk }] },
    });

    await withEnv(publishEnv("/tmp/bonk-test/absent.json"), () => publishReview());

    expect(
      requests.every((request) => request.method === "GET" || request.url.endsWith("/graphql")),
    ).toBe(true);
  });
});
