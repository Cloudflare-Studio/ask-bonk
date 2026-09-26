import { mkdirSync, writeFileSync } from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  anchorFinding,
  buildStickyBody,
  isReviewRun,
  parseCommentableLines,
  partitionFindings,
  parseReviewFile,
  publishReview,
  type BonkThread,
  type Finding,
} from "../github/script/review-publish";
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
            { path: "src/a.ts", line: 11, body: "Bug" },
            { path: "src/a.ts", line: 12, start_line: 10, side: "LEFT", body: "Range" },
            { path: "src/a.ts", line: 0, body: "Bad line" },
            { path: "", line: 3, body: "No path" },
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
        { path: "src/a.ts", line: 11, side: "RIGHT", body: "Bug" },
        { path: "src/a.ts", line: 12, startLine: 10, side: "LEFT", body: "Range" },
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

  it("matches findings to Bonk's threads and resolves only unanswered stale ones", () => {
    const thread = (id: string, overrides: Partial<BonkThread>): BonkThread => ({
      id,
      resolved: false,
      path: "src/a.ts",
      line: 20,
      hasHumanReplies: false,
      ...overrides,
    });
    const threads = [
      thread("open-near", { line: 20 }),
      thread("resolved", { line: 60, resolved: true }),
      thread("stale", { line: 90 }),
      thread("answered", { line: 120, hasHumanReplies: true }),
      thread("acted", { line: 150 }),
      thread("untouched-file", { path: "src/b.ts" }),
    ];
    const finding = (line: number): Finding => ({
      path: "src/a.ts",
      line,
      side: "RIGHT",
      body: "x",
    });

    const result = partitionFindings(
      [finding(24), finding(58), finding(200)],
      threads,
      new Set(["acted"]),
      ["src/a.ts"],
    );
    expect(result.toPost).toEqual([finding(200)]);
    expect(result.toResolve.map((entry) => entry.id)).toEqual(["stale"]);

    // A full review may resolve stale threads in any file.
    expect(
      partitionFindings([], threads, new Set(), null).toResolve.map((entry) => entry.id),
    ).toEqual(["open-near", "stale", "acted", "untouched-file"]);
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
        { path: "src/a.ts", line: 11, body: "Null deref" },
        { path: "docs/missing.md", line: 1, body: "Document the flag" },
      ],
    });

    await withEnv(publishEnv(reviewFile), () => publishReview());

    const review = requests.find((request) => request.url.endsWith("/pulls/5/reviews"));
    expect(review?.body).toEqual({
      commit_id: HEAD,
      event: "COMMENT",
      body: "",
      comments: [{ path: "src/a.ts", line: 11, side: "RIGHT", body: "Null deref" }],
    });

    const patch = requests.find((request) => request.method === "PATCH");
    expect(patch?.url).toBe("https://api.github.com/repos/owner/repo/issues/comments/10");
    const body = patchedBody(patch);
    expect(body).toContain("Review: 2 findings.");
    expect(body).toContain(
      "**Findings outside the diff**\n\n- `docs/missing.md:1`: Document the flag",
    );
    expect(body).not.toContain("[github run](/owner/repo/actions/runs/100)\n");
    expect(parseReviewStateMarker(body)).toEqual({ head: HEAD, base: BASE });

    const deleted = requests.find((request) => request.method === "DELETE");
    expect(deleted?.url).toBe("https://api.github.com/repos/owner/repo/issues/comments/11");
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
    expect(body).toContain("- `src/a.ts:11`: Null deref");
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
      findings: [{ path: "src/a.ts", line: 41, body: "Still leaks" }],
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
    // The still-open finding matches its thread and is not posted again.
    expect(requests.some((request) => request.url.endsWith("/pulls/5/reviews"))).toBe(false);
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
