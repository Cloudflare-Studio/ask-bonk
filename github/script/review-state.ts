// Re-review context for pull requests (opt-in via the `rereview_context` input).
//
// Preflight loads what Bonk said about the pull request before: the head it
// last reviewed, its previous summary, and its inline threads with GitHub's
// resolved/outdated state. After OpenCode posts its response, this script runs
// again as its own step and stamps that response with a hidden state marker so
// the next run knows which head was reviewed.

import { pathToFileURL } from "url";
import { core, escapePromptValue } from "./context";
import { fetchWithRetry } from "./http";

const MARKER_PATTERN = /<!-- bonk-review-state:(\{[^\n]*?\}) -->/g;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const STALE_NOTE_PATTERN =
  /\n*> \[!NOTE\]\n> This response reflects [0-9a-f]+; the pull request head has since moved to [0-9a-f]+\./g;
// opencode appends `[github run](/owner/repo/actions/runs/<id>)`, optionally
// preceded by a share card and session link, to every response it posts.
const OPENCODE_FOOTER_PATTERN =
  /\n*(?:<a href="[^"\n]*"><img [^\n]*\/><\/a>\n)?(?:\[opencode session\]\([^)\n]*\)&nbsp;&nbsp;\|&nbsp;&nbsp;)?\[github run\]\([^)\n]*\)\s*$/;
// Used only if GitHub does not report the installation token's own login.
const DEFAULT_BOT_LOGIN = "ask-bonk";
// Compare API responses list at most this many files; a diff at the cap may be
// incomplete, so its delta cannot be trusted.
const COMPARE_FILE_LIMIT = 300;
// The harness guidance makes every review response start with one of these
// verdict lines. `LGTM` without the bang is accepted because repository prompts
// sometimes ask for it.
const REVIEW_VERDICT_PATTERN =
  /^\s*(?:LGTM!?(?=\s|$)|Review: \d+ findings?\.|Since last review: \d+ resolved, \d+ still open, \d+ new\.)/;
const MAX_SUMMARY_CHARS = 6000;
const MAX_COMMENT_CHARS = 1500;
const MAX_THREADS = 50;
const MAX_LISTED_FILES = 100;

export interface ReviewState {
  head: string;
  base: string;
}

interface GraphQLAuthor {
  __typename?: string;
  login?: string;
}

interface GraphQLComment {
  databaseId?: number;
  author?: GraphQLAuthor | null;
  body?: string;
  url?: string;
  originalCommit?: { oid?: string } | null;
}

interface GraphQLReview {
  databaseId?: number;
  author?: GraphQLAuthor | null;
  commit?: { oid?: string } | null;
}

export interface PullRequestHistory {
  headRefOid?: string;
  baseRefOid?: string;
  comments?: { nodes?: GraphQLComment[] };
  reviews?: { nodes?: GraphQLReview[] };
  reviewThreads?: {
    nodes?: Array<{
      isResolved?: boolean;
      isOutdated?: boolean;
      path?: string;
      line?: number | null;
      originalLine?: number | null;
      comments?: { nodes?: GraphQLComment[] };
    }>;
  };
}

export interface PreviousReview {
  head: string;
  base: string;
  source: "state_marker" | "inline_review";
  summary?: string;
  summaryUrl?: string;
}

export interface PreviousThread {
  resolved: boolean;
  outdated: boolean;
  path: string;
  line?: number;
  commit?: string;
  finding: string;
  replies: Array<{ author: string; body: string }>;
}

export interface ReviewHistory {
  headSha: string;
  baseSha: string;
  previous: PreviousReview | null;
  threads: PreviousThread[];
  // Newest review Bonk submitted before this run; a higher id afterwards means
  // this run submitted a review.
  lastReviewId: number;
}

export interface CompareFile {
  filename: string;
  status: string;
  sha?: string;
  patch?: string;
}

// A pull request's diff as GitHub shows it: head against its merge base.
export interface PullRequestDiff {
  mergeBase: string;
  files: CompareFile[];
}

// What the author changed between two reviews, excluding anything merged in
// from the base branch.
export interface ReviewDelta {
  kind: "none" | "base_only" | "author_changes" | "unknown";
  lastMergeBase?: string;
  currentMergeBase?: string;
  files: Array<{ filename: string; status: string }>;
}

export interface ReviewContext {
  headSha: string;
  baseSha: string;
  lastReviewId: number;
  block: string | null;
}

export function formatReviewStateMarker(state: ReviewState): string {
  return `<!-- bonk-review-state:${JSON.stringify({ head: state.head, base: state.base })} -->`;
}

// Returns the last well-formed marker in the body. Callers must only pass
// bodies authored by Bonk: anyone can type a marker into a comment.
export function parseReviewStateMarker(body: string): ReviewState | null {
  let state: ReviewState | null = null;
  for (const match of body.matchAll(MARKER_PATTERN)) {
    try {
      const parsed = JSON.parse(match[1]) as Partial<ReviewState>;
      if (typeof parsed.head === "string" && SHA_PATTERN.test(parsed.head)) {
        state = {
          head: parsed.head,
          base: typeof parsed.base === "string" && SHA_PATTERN.test(parsed.base) ? parsed.base : "",
        };
      }
    } catch {
      // Malformed marker: keep the previous valid one.
    }
  }
  return state;
}

function stripReviewState(body: string): string {
  return body.replace(MARKER_PATTERN, "").replace(STALE_NOTE_PATTERN, "").trimEnd();
}

function normalizeLogin(login: string): string {
  return login
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, "");
}

// Bonk's own comments are recognized by GitHub App identity: `viewer` on an
// installation token is the App's bot account, so self-hosted Apps need no
// configuration.
function botLogin(viewer: GraphQLAuthor | null | undefined): string {
  return normalizeLogin(viewer?.login || DEFAULT_BOT_LOGIN);
}

function isBonk(author: GraphQLAuthor | null | undefined, login: string): boolean {
  return author?.__typename === "Bot" && normalizeLogin(author.login || "") === login;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}… [truncated]` : trimmed;
}

export function summarizeReviewHistory(pr: PullRequestHistory, login: string): ReviewHistory {
  let previous: PreviousReview | null = null;

  const comments = pr.comments?.nodes ?? [];
  for (let index = comments.length - 1; index >= 0 && !previous; index -= 1) {
    const comment = comments[index];
    if (!isBonk(comment.author, login)) continue;
    const state = parseReviewStateMarker(comment.body || "");
    if (!state) continue;
    previous = {
      ...state,
      source: "state_marker",
      summary: stripReviewState(comment.body || "").replace(OPENCODE_FOOTER_PATTERN, ""),
      summaryUrl: comment.url,
    };
  }

  // Before the first marker exists, the newest inline review still pins the
  // commit Bonk looked at.
  const bonkReviews = (pr.reviews?.nodes ?? []).filter((review) => isBonk(review.author, login));
  if (!previous) {
    const oid = bonkReviews.at(-1)?.commit?.oid;
    if (oid && SHA_PATTERN.test(oid)) previous = { head: oid, base: "", source: "inline_review" };
  }

  const threads: PreviousThread[] = [];
  for (const thread of pr.reviewThreads?.nodes ?? []) {
    const [first, ...rest] = thread.comments?.nodes ?? [];
    if (!first || !isBonk(first.author, login)) continue;
    threads.push({
      resolved: Boolean(thread.isResolved),
      outdated: Boolean(thread.isOutdated),
      path: thread.path || "unknown",
      line: thread.line ?? thread.originalLine ?? undefined,
      commit: first.originalCommit?.oid,
      finding: first.body || "",
      replies: rest.map((reply) => ({
        author: isBonk(reply.author, login) ? "bonk" : `@${reply.author?.login || "ghost"}`,
        body: reply.body || "",
      })),
    });
  }

  return {
    headSha: pr.headRefOid || "",
    baseSha: pr.baseRefOid || "",
    previous,
    threads: threads.slice(-MAX_THREADS),
    lastReviewId: Math.max(0, ...bonkReviews.map((review) => review.databaseId ?? 0)),
  };
}

// Reduces a patch to what the pull request changed. Hunk header line numbers
// move whenever the base branch moves under the pull request, so drop them.
export function normalizePatch(patch: string): string {
  return patch
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => (line.startsWith("@@") ? "@@" : line))
    .join("\n");
}

function sameFileDiff(before: CompareFile, after: CompareFile): boolean {
  if (before.status !== after.status) return false;
  if (before.patch !== undefined && after.patch !== undefined) {
    return normalizePatch(before.patch) === normalizePatch(after.patch);
  }
  // GitHub omits patches for binary and very large files; then only an
  // identical blob proves the pull request's change to the file is unchanged.
  return (
    before.patch === undefined &&
    after.patch === undefined &&
    Boolean(before.sha) &&
    before.sha === after.sha
  );
}

// Interdiff of the pull request's diff at the last review and now, per file.
// Files that differ only because the base branch moved (or was merged in) keep
// the same patch against their merge base and drop out.
export function computeReviewDelta(
  previous: PullRequestDiff,
  current: PullRequestDiff,
): ReviewDelta {
  const mergeBases = { lastMergeBase: previous.mergeBase, currentMergeBase: current.mergeBase };
  if (previous.files.length >= COMPARE_FILE_LIMIT || current.files.length >= COMPARE_FILE_LIMIT) {
    return { kind: "unknown", ...mergeBases, files: [] };
  }
  const before = new Map(previous.files.map((file) => [file.filename, file]));
  const after = new Map(current.files.map((file) => [file.filename, file]));
  const files: ReviewDelta["files"] = [];
  for (const filename of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(filename);
    const now = after.get(filename);
    if (old && now && sameFileDiff(old, now)) continue;
    files.push({
      filename,
      status: now ? (old ? now.status : "added to pull request") : "removed from pull request",
    });
  }
  const kind =
    files.length > 0
      ? "author_changes"
      : previous.mergeBase !== current.mergeBase
        ? "base_only"
        : "none";
  return { kind, ...mergeBases, files };
}

function indent(text: string, prefix: string): string {
  return escapePromptValue(text).replace(/\r?\n/g, `\n${prefix}`);
}

export function formatPreviousReviewBlock(
  history: ReviewHistory,
  delta: ReviewDelta | null,
): string | null {
  const { previous, threads } = history;
  if (!previous && threads.length === 0) return null;

  const lines = ["<bonk_previous_review>"];
  if (previous) {
    lines.push(`last_reviewed_head: ${previous.head}`);
    lines.push(`last_reviewed_head_source: ${previous.source}`);
    if (previous.base) lines.push(`last_reviewed_base: ${previous.base}`);
  }
  lines.push(`current_head: ${history.headSha}`);
  if (history.baseSha) lines.push(`current_base: ${history.baseSha}`);

  lines.push(`changes_since_last_review: ${previous && delta ? delta.kind : "unknown"}`);
  if (previous && delta?.lastMergeBase && delta.currentMergeBase) {
    lines.push(`last_review_merge_base: ${delta.lastMergeBase}`);
    lines.push(`current_merge_base: ${delta.currentMergeBase}`);
  }
  if (previous && delta?.kind === "author_changes") {
    lines.push(
      `author_changed_files: ${delta.files.length} (files whose pull request diff changed since the last review; changes merged from the base branch are excluded)`,
    );
    for (const file of delta.files.slice(0, MAX_LISTED_FILES)) {
      lines.push(`- ${escapePromptValue(file.status)} ${escapePromptValue(file.filename)}`);
    }
    if (delta.files.length > MAX_LISTED_FILES) {
      lines.push(`- … ${delta.files.length - MAX_LISTED_FILES} more`);
    }
    // With an unchanged merge base, the tree diff between the two heads is
    // exactly the author's change. Otherwise it would include the base
    // branch's changes, so compare each file's pull request diff instead.
    if (delta.lastMergeBase === delta.currentMergeBase) {
      lines.push(`incremental_diff: git diff ${previous.head} ${history.headSha}`);
    } else {
      lines.push(
        `author_delta: for each listed file, compare \`git diff ${delta.lastMergeBase} ${previous.head} -- <file>\` with \`git diff ${delta.currentMergeBase} ${history.headSha} -- <file>\``,
      );
    }
  }

  if (previous?.summary) {
    if (previous.summaryUrl)
      lines.push(`previous_summary_url: ${escapePromptValue(previous.summaryUrl)}`);
    lines.push("previous_summary:");
    lines.push(`  ${indent(truncate(previous.summary, MAX_SUMMARY_CHARS), "  ")}`);
  }

  if (threads.length > 0) {
    lines.push("previous_inline_findings:");
    for (const thread of threads) {
      const state = [
        thread.resolved ? "resolved" : "unresolved",
        ...(thread.outdated ? ["outdated"] : []),
      ];
      const location = thread.line ? `${thread.path}:${thread.line}` : thread.path;
      const commit = thread.commit ? ` (commented on ${thread.commit.slice(0, 12)})` : "";
      lines.push(`- [${state.join(", ")}] ${escapePromptValue(location)}${commit}`);
      lines.push(`  finding: ${indent(truncate(thread.finding, MAX_COMMENT_CHARS), "    ")}`);
      for (const reply of thread.replies) {
        lines.push(
          `  reply from ${escapePromptValue(reply.author)}: ${indent(truncate(reply.body, MAX_COMMENT_CHARS), "    ")}`,
        );
      }
    }
  }

  lines.push("</bonk_previous_review>");
  return lines.join("\n");
}

async function githubGraphQL<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const resp = await fetchWithRetry(
    "https://api.github.com/graphql",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    },
    { timeoutMs: 10000 },
  );
  if (!resp.ok) throw new Error(`GitHub GraphQL returned ${resp.status}: ${await resp.text()}`);
  const payload = (await resp.json()) as { data?: T; errors?: Array<{ message?: string }> };
  if (payload.errors?.length || !payload.data) {
    throw new Error(`GitHub GraphQL error: ${payload.errors?.[0]?.message || "missing data"}`);
  }
  return payload.data;
}

function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner = "", repo = ""] = repository.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository: ${repository}`);
  return { owner, repo };
}

const HISTORY_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      baseRefOid
      comments(last: 100) { nodes { author { __typename login } body url } }
      reviews(last: 50) { nodes { databaseId author { __typename login } commit { oid } } }
      reviewThreads(last: 100) {
        nodes {
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: 20) { nodes { author { __typename login } body originalCommit { oid } } }
        }
      }
    }
  }
}`;

async function fetchPullRequestDiff(
  repository: string,
  base: string,
  head: string,
  token: string,
): Promise<PullRequestDiff | null> {
  // A three-dot compare diffs `head` against its merge base with `base`, which
  // is the pull request diff as of `head`. A force-pushed head can be
  // garbage-collected; treat any failure as an unknown change set.
  const resp = await fetchWithRetry(
    `https://api.github.com/repos/${repository}/compare/${base}...${head}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
    { timeoutMs: 10000 },
  );
  if (!resp.ok) return null;
  const data = (await resp.json()) as {
    merge_base_commit?: { sha?: string };
    files?: Array<{ filename?: string; status?: string; sha?: string; patch?: string }>;
  };
  const mergeBase = data.merge_base_commit?.sha;
  if (!mergeBase) return null;
  return {
    mergeBase,
    files: (data.files ?? []).map((file) => ({
      filename: file.filename || "",
      status: file.status || "modified",
      sha: file.sha,
      patch: file.patch,
    })),
  };
}

async function loadReviewDelta(
  repository: string,
  history: ReviewHistory,
  token: string,
): Promise<ReviewDelta | null> {
  const { previous } = history;
  if (!previous) return null;
  if (previous.head === history.headSha) return { kind: "none", files: [] };
  // Before the first marker, the old base is unknown. The merge base of the
  // current base with the old head is still the old merge base unless the
  // base branch itself was rewritten.
  const [before, after] = await Promise.all([
    fetchPullRequestDiff(repository, previous.base || history.baseSha, previous.head, token),
    fetchPullRequestDiff(repository, history.baseSha, history.headSha, token),
  ]);
  return before && after ? computeReviewDelta(before, after) : { kind: "unknown", files: [] };
}

export async function loadReviewContext(
  repository: string,
  prNumber: string,
  token: string,
): Promise<ReviewContext> {
  const { owner, repo } = splitRepository(repository);
  const data = await githubGraphQL<{
    viewer?: GraphQLAuthor | null;
    repository?: { pullRequest?: PullRequestHistory | null };
  }>(token, HISTORY_QUERY, { owner, repo, number: Number.parseInt(prNumber, 10) });
  const pr = data.repository?.pullRequest;
  if (!pr?.headRefOid) throw new Error(`Pull request #${prNumber} not found`);

  const history = summarizeReviewHistory(pr, botLogin(data.viewer));
  const delta = await loadReviewDelta(repository, history, token);
  return {
    headSha: history.headSha,
    baseSha: history.baseSha,
    lastReviewId: history.lastReviewId,
    block: formatPreviousReviewBlock(history, delta),
  };
}

const RESPONSE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      comments(last: 30) { nodes { databaseId author { __typename login } body } }
      reviews(last: 20) { nodes { databaseId author { __typename login } } }
    }
  }
}`;

// Only review runs move the last reviewed head; a `/bonk explain` answer must
// not hide unreviewed commits from the next review. Signals, most
// deterministic first: the run was triggered by a pull_request event (which
// always asks for a review), Bonk submitted a review during the run, or the
// response starts with a verdict line.
export function isReviewRun(
  eventName: string,
  lastReviewId: number,
  reviewIds: number[],
  responseBody: string,
): boolean {
  return (
    eventName === "pull_request" ||
    reviewIds.some((id) => id > lastReviewId) ||
    REVIEW_VERDICT_PATTERN.test(responseBody)
  );
}

// Stamps this run's OpenCode response with the head it reviewed. Runs after
// OpenCode, so it is best-effort and never fails the job.
export async function recordReviewState(): Promise<void> {
  const token = process.env.GH_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY || "";
  const prNumber = process.env.PR_NUMBER || "";
  const runId = process.env.GITHUB_RUN_ID || "";
  const head = process.env.REVIEWED_HEAD_SHA || "";
  const base = process.env.REVIEWED_BASE_SHA || "";
  if (!token || !repository || !prNumber || !runId || !SHA_PATTERN.test(head)) {
    core.info("Review state context incomplete; skipping.");
    return;
  }

  const { owner, repo } = splitRepository(repository);
  const data = await githubGraphQL<{
    viewer?: GraphQLAuthor | null;
    repository?: {
      pullRequest?: {
        headRefOid?: string;
        comments?: { nodes?: GraphQLComment[] };
        reviews?: { nodes?: GraphQLReview[] };
      } | null;
    };
  }>(token, RESPONSE_QUERY, { owner, repo, number: Number.parseInt(prNumber, 10) });
  const pr = data.repository?.pullRequest;
  const login = botLogin(data.viewer);

  // opencode links every response it posts to the run that produced it, so
  // the run URL identifies this run's comment among Bonk's comments.
  const runLink = `/${repository}/actions/runs/${runId})`;
  const response = (pr?.comments?.nodes ?? [])
    .toReversed()
    .find((comment) => isBonk(comment.author, login) && comment.body?.includes(runLink));
  if (!response?.databaseId || !response.body) {
    core.info("No Bonk response for this run found; skipping review state.");
    return;
  }

  const reviewIds = (pr?.reviews?.nodes ?? [])
    .filter((review) => isBonk(review.author, login))
    .map((review) => review.databaseId ?? 0);
  const lastReviewId = Number.parseInt(process.env.LAST_REVIEW_ID || "0", 10) || 0;
  if (!isReviewRun(process.env.EVENT_NAME || "", lastReviewId, reviewIds, response.body)) {
    core.info(
      "This run did not review the pull request; leaving the last reviewed head unchanged.",
    );
    return;
  }

  let body = stripReviewState(response.body);
  const liveHead = pr?.headRefOid || "";
  if (liveHead && liveHead !== head && liveHead !== process.env.WORKSPACE_HEAD_SHA) {
    body += `\n\n> [!NOTE]\n> This response reflects ${head.slice(0, 12)}; the pull request head has since moved to ${liveHead.slice(0, 12)}.`;
  }
  body += `\n\n${formatReviewStateMarker({ head, base })}`;

  const resp = await fetchWithRetry(
    `https://api.github.com/repos/${repository}/issues/comments/${response.databaseId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    },
  );
  if (!resp.ok) {
    core.warning(`Failed to record review state (${resp.status}): ${await resp.text()}`);
    return;
  }
  core.info(`Recorded review state for ${head} on comment ${response.databaseId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  recordReviewState().catch((error) => {
    core.warning(`Failed to record review state: ${error}`);
  });
}
