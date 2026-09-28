// Re-review context for pull requests (opt-in via the `rereview_context` input).
//
// Preflight loads what Bonk said about the pull request before: the head it
// last reviewed, its previous summary, and its inline threads with GitHub's
// resolved/outdated state. review-publish.ts writes the state marker this
// reads back.

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { escapePromptValue } from "./context";
import { fetchWithRetry } from "./http";
import { neutralizeTags, patchFileName } from "./review-diff";

const MARKER_PATTERN = /<!-- bonk-review-state:(\{[^\n]*?\}) -->/g;
export const SHA_PATTERN = /^[0-9a-f]{40}$/;
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
const MAX_SUMMARY_CHARS = 6000;
const MAX_COMMENT_CHARS = 1500;
const MAX_THREADS = 50;
const MAX_LISTED_FILES = 100;

export interface ReviewState {
  head: string;
  base: string;
  // Each specialist's status in that review, used to skip specialists whose
  // files the author has not touched since.
  specialists?: Record<string, string>;
}

export interface GraphQLAuthor {
  __typename?: string;
  login?: string;
}

export interface GraphQLComment {
  id?: string;
  databaseId?: number;
  author?: GraphQLAuthor | null;
  body?: string;
  url?: string;
  originalCommit?: { oid?: string } | null;
}

export interface GraphQLReview {
  databaseId?: number;
  author?: GraphQLAuthor | null;
  commit?: { oid?: string } | null;
}

// A review thread with its first comment (the finding) followed by its newest
// replies; `omittedReplies` counts replies in between that were not fetched.
export interface ReviewThreadNode {
  id?: string;
  isResolved?: boolean;
  isOutdated?: boolean;
  path?: string;
  line?: number | null;
  originalLine?: number | null;
  comments?: { nodes?: GraphQLComment[] };
  omittedReplies?: number;
}

export interface PullRequestHistory {
  headRefOid?: string;
  baseRefOid?: string;
  baseRefName?: string;
  comments?: { nodes?: GraphQLComment[] };
  reviews?: { nodes?: GraphQLReview[] };
  reviewThreads?: { nodes?: ReviewThreadNode[] };
}

export interface PreviousReview {
  head: string;
  base: string;
  specialists?: Record<string, string>;
  source: "state_marker" | "inline_review";
  summary?: string;
  summaryUrl?: string;
}

export interface PreviousThread {
  id: string;
  resolved: boolean;
  omittedReplies?: number;
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
  files: Array<{ filename: string; status: string; before?: string; after?: string }>;
}

// Inline the author delta's patches below this many bytes.
const DELTA_PROMPT_BUDGET = 50_000;

export interface ReviewContext {
  headSha: string;
  baseSha: string;
  // The pull request's base branch.
  baseRef: string;
  lastReviewId: number;
  // Files the author changed since the last review, or null when this review
  // covers the whole pull request.
  changedFiles: string[] | null;
  // Bonk reviewed this pull request before.
  rereview: boolean;
  // Specialist statuses from the last review's marker.
  previousSpecialists: Record<string, string> | null;
  block: string | null;
  // The same block with the author delta listed by file path instead of
  // inlined, for prompts that would otherwise be too large.
  compactBlock: string | null;
}

export function formatReviewStateMarker(state: ReviewState): string {
  const specialists =
    state.specialists && Object.keys(state.specialists).length > 0
      ? { specialists: state.specialists }
      : {};
  return `<!-- bonk-review-state:${JSON.stringify({ head: state.head, base: state.base, ...specialists })} -->`;
}

function parseSpecialistMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// Returns the last well-formed marker in the body. Callers must only pass
// bodies authored by Bonk: anyone can type a marker into a comment.
export function parseReviewStateMarker(body: string): ReviewState | null {
  let state: ReviewState | null = null;
  for (const match of body.matchAll(MARKER_PATTERN)) {
    try {
      const parsed = JSON.parse(match[1]) as Partial<ReviewState>;
      if (typeof parsed.head === "string" && SHA_PATTERN.test(parsed.head)) {
        const specialists = parseSpecialistMap(parsed.specialists);
        state = {
          head: parsed.head,
          base: typeof parsed.base === "string" && SHA_PATTERN.test(parsed.base) ? parsed.base : "",
          ...(specialists ? { specialists } : {}),
        };
      }
    } catch {
      // Malformed marker: keep the previous valid one.
    }
  }
  return state;
}

export function stripReviewState(body: string): string {
  return body.replace(MARKER_PATTERN, "").replace(STALE_NOTE_PATTERN, "").trimEnd();
}

export function stripOpencodeFooter(body: string): string {
  return body.replace(OPENCODE_FOOTER_PATTERN, "");
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
export function botLogin(viewer: GraphQLAuthor | null | undefined): string {
  return normalizeLogin(viewer?.login || DEFAULT_BOT_LOGIN);
}

export function isBonk(author: GraphQLAuthor | null | undefined, login: string): boolean {
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
      summary: stripOpencodeFooter(stripReviewState(comment.body || "")),
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
    if (!first || !isBonk(first.author, login) || !thread.id) continue;
    threads.push({
      id: thread.id,
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
      ...(thread.omittedReplies ? { omittedReplies: thread.omittedReplies } : {}),
    });
  }

  // Keep the prompt bounded: every open thread fits before resolved ones.
  const open = threads.filter((thread) => !thread.resolved).slice(-MAX_THREADS);
  const room = MAX_THREADS - open.length;
  const resolved = room > 0 ? threads.filter((thread) => thread.resolved).slice(-room) : [];
  const kept = new Set([...open, ...resolved]);

  return {
    headSha: pr.headRefOid || "",
    baseSha: pr.baseRefOid || "",
    previous,
    threads: threads.filter((thread) => kept.has(thread)),
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
      ...(old?.patch !== undefined ? { before: old.patch } : {}),
      ...(now?.patch !== undefined ? { after: now.patch } : {}),
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

// Writes each author-changed file's pull request patch at the last review
// ("before") and now ("after"). Both are against the file's merge base, so
// changes from the base branch cancel out when they are compared.
export function deltaPatchPaths(dir: string, filename: string): { before: string; after: string } {
  const base = join(dir, patchFileName(filename).replace(/\.patch$/, ""));
  return { before: `${base}.before.patch`, after: `${base}.after.patch` };
}

export function writeDeltaPatches(
  dir: string,
  delta: ReviewDelta,
): Map<string, { before?: string; after?: string }> {
  const paths = new Map<string, { before?: string; after?: string }>();
  mkdirSync(dir, { recursive: true });
  for (const file of delta.files) {
    const names = deltaPatchPaths(dir, file.filename);
    const entry: { before?: string; after?: string } = {};
    if (file.before !== undefined) {
      entry.before = names.before;
      writeFileSync(entry.before, file.before);
    }
    if (file.after !== undefined) {
      entry.after = names.after;
      writeFileSync(entry.after, file.after);
    }
    paths.set(file.filename, entry);
  }
  return paths;
}

export function formatPreviousReviewBlock(
  history: ReviewHistory,
  delta: ReviewDelta | null,
  deltaPaths?: Map<string, { before?: string; after?: string }>,
  deltaBudget = DELTA_PROMPT_BUDGET,
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
    lines.push(
      "author_delta: for each listed file, compare its pull request patch at the last review (before) with its patch now (after). Both are against the file's merge base, so base-branch changes cancel out.",
    );
    const bytes = delta.files.reduce(
      (sum, file) =>
        sum + Buffer.byteLength(file.before ?? "") + Buffer.byteLength(file.after ?? ""),
      0,
    );
    // Without patch files to point at, the full budget still applies.
    if (bytes <= deltaBudget || (!deltaPaths && bytes <= DELTA_PROMPT_BUDGET)) {
      for (const file of delta.files.slice(0, MAX_LISTED_FILES)) {
        for (const side of ["before", "after"] as const) {
          lines.push(`=== ${escapePromptValue(file.filename)} (${side}) ===`);
          lines.push(
            file[side] === undefined
              ? "(not in the pull request)"
              : neutralizeTags(file[side].trimEnd()),
          );
        }
      }
    } else if (deltaPaths) {
      for (const file of delta.files.slice(0, MAX_LISTED_FILES)) {
        const paths = deltaPaths.get(file.filename);
        lines.push(
          `- ${escapePromptValue(file.filename)}: before ${escapePromptValue(paths?.before ?? "(none)")}, after ${escapePromptValue(paths?.after ?? "(none)")}`,
        );
      }
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
      lines.push(`  thread: ${escapePromptValue(thread.id)}`);
      lines.push(`  finding: ${indent(truncate(thread.finding, MAX_COMMENT_CHARS), "    ")}`);
      if (thread.omittedReplies)
        lines.push(`  (${thread.omittedReplies} earlier replies not shown)`);
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

export async function githubGraphQL<T>(
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

export function splitRepository(repository: string): { owner: string; repo: string } {
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
      baseRefName
    }
  }
}`;

// Busy pull requests have hundreds of comments and threads, so both are read
// page by page rather than from a fixed window that could miss the sticky
// summary or older threads. The caps only bound runaway loops.
const MAX_PAGES = 30;
const THREAD_REPLIES = 20;

interface Page<T> {
  nodes?: T[];
  pageInfo?: {
    hasNextPage?: boolean;
    hasPreviousPage?: boolean;
    endCursor?: string;
    startCursor?: string;
  };
}

const COMMENTS_PAGE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $before: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      comments(last: 100, before: $before) {
        nodes { databaseId author { __typename login } body url }
        pageInfo { hasPreviousPage startCursor }
      }
    }
  }
}`;

// Pages backwards from the newest comment and returns the first Bonk comment
// carrying a review-state marker, i.e. the sticky review summary. Without
// one, it returns the newest Bonk comment `adopt` accepts, if any.
export async function findStickyComment(
  token: string,
  repository: string,
  prNumber: string,
  login: string,
  exclude?: number,
  adopt?: (comment: GraphQLComment) => boolean,
): Promise<GraphQLComment | null> {
  const { owner, repo } = splitRepository(repository);
  let before: string | undefined;
  let adopted: GraphQLComment | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await githubGraphQL<{
      repository?: { pullRequest?: { comments?: Page<GraphQLComment> } | null };
    }>(token, COMMENTS_PAGE_QUERY, {
      owner,
      repo,
      number: Number.parseInt(prNumber, 10),
      before: before ?? null,
    });
    const comments = data.repository?.pullRequest?.comments;
    const candidates = (comments?.nodes ?? [])
      .toReversed()
      .filter(
        (comment) =>
          (exclude === undefined || comment.databaseId !== exclude) &&
          isBonk(comment.author, login),
      );
    const sticky = candidates.find(
      (comment) => parseReviewStateMarker(comment.body || "") !== null,
    );
    if (sticky) return sticky;
    adopted ??= (adopt && candidates.find(adopt)) || null;
    if (!comments?.pageInfo?.hasPreviousPage || !comments.pageInfo.startCursor) return adopted;
    before = comments.pageInfo.startCursor;
  }
  return adopted;
}

const REVIEWS_PAGE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $before: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(last: 100, before: $before) {
        nodes { databaseId author { __typename login } commit { oid } }
        pageInfo { hasPreviousPage startCursor }
      }
    }
  }
}`;

// Bonk's reviews, oldest first, paging back from the newest. Without
// `sinceId` it stops at the newest Bonk review; with it, at the first review
// at or below that id, so every Bonk review after it is returned.
export async function fetchBonkReviews(
  token: string,
  repository: string,
  prNumber: string,
  login: string,
  sinceId?: number,
): Promise<GraphQLReview[]> {
  const { owner, repo } = splitRepository(repository);
  const found: GraphQLReview[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await githubGraphQL<{
      repository?: { pullRequest?: { reviews?: Page<GraphQLReview> } | null };
    }>(token, REVIEWS_PAGE_QUERY, {
      owner,
      repo,
      number: Number.parseInt(prNumber, 10),
      before: before ?? null,
    });
    const reviews = data.repository?.pullRequest?.reviews;
    for (const review of (reviews?.nodes ?? []).toReversed()) {
      if (sinceId !== undefined && (review.databaseId ?? 0) <= sinceId) return found.toReversed();
      if (!isBonk(review.author, login)) continue;
      found.push(review);
      if (sinceId === undefined) return found;
    }
    if (!reviews?.pageInfo?.hasPreviousPage || !reviews.pageInfo.startCursor) break;
    before = reviews.pageInfo.startCursor;
  }
  return found.toReversed();
}

const THREADS_PAGE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          first: comments(first: 1) {
            nodes { id author { __typename login } body url originalCommit { oid } }
          }
          recent: comments(last: ${THREAD_REPLIES}) {
            totalCount
            nodes { id author { __typename login } body }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

interface RawThreadNode extends Omit<ReviewThreadNode, "comments" | "omittedReplies"> {
  first?: { nodes?: GraphQLComment[] };
  recent?: { totalCount?: number; nodes?: GraphQLComment[] };
}

// The finding is the thread's first comment, and the newest replies ("won't
// fix", "fixed in ...") matter most, so each thread is read from both ends.
export function mergeThreadComments(raw: RawThreadNode): ReviewThreadNode {
  const { first, recent, ...thread } = raw;
  const root = first?.nodes?.[0];
  const replies = (recent?.nodes ?? []).filter((comment) => !root || comment.id !== root.id);
  const total = recent?.totalCount ?? replies.length + (root ? 1 : 0);
  return {
    ...thread,
    comments: { nodes: [...(root ? [root] : []), ...replies] },
    omittedReplies: Math.max(0, total - (root ? 1 : 0) - replies.length),
  };
}

export async function fetchReviewThreads(
  token: string,
  repository: string,
  prNumber: string,
): Promise<ReviewThreadNode[]> {
  const { owner, repo } = splitRepository(repository);
  const threads: ReviewThreadNode[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await githubGraphQL<{
      repository?: { pullRequest?: { reviewThreads?: Page<RawThreadNode> } | null };
    }>(token, THREADS_PAGE_QUERY, {
      owner,
      repo,
      number: Number.parseInt(prNumber, 10),
      after: after ?? null,
    });
    const connection = data.repository?.pullRequest?.reviewThreads;
    threads.push(...(connection?.nodes ?? []).map(mergeThreadComments));
    if (!connection?.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) break;
    after = connection.pageInfo.endCursor;
  }
  return threads;
}

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

function reviewScope(delta: ReviewDelta | null): string[] | null {
  if (!delta || delta.kind === "unknown") return null;
  return delta.files.map((file) => file.filename);
}

export async function loadReviewContext(
  repository: string,
  prNumber: string,
  token: string,
  diffDir?: string,
): Promise<ReviewContext> {
  const { owner, repo } = splitRepository(repository);
  const data = await githubGraphQL<{
    viewer?: GraphQLAuthor | null;
    repository?: { pullRequest?: PullRequestHistory | null };
  }>(token, HISTORY_QUERY, { owner, repo, number: Number.parseInt(prNumber, 10) });
  const pr = data.repository?.pullRequest;
  if (!pr?.headRefOid) throw new Error(`Pull request #${prNumber} not found`);

  const login = botLogin(data.viewer);
  const [sticky, threads, reviews] = await Promise.all([
    findStickyComment(token, repository, prNumber, login),
    fetchReviewThreads(token, repository, prNumber),
    fetchBonkReviews(token, repository, prNumber, login),
  ]);
  const history = summarizeReviewHistory(
    {
      ...pr,
      comments: { nodes: sticky ? [sticky] : [] },
      reviews: { nodes: reviews },
      reviewThreads: { nodes: threads },
    },
    login,
  );
  const delta = await loadReviewDelta(repository, history, token);
  const deltaPaths =
    diffDir && delta?.kind === "author_changes"
      ? writeDeltaPatches(join(diffDir, "delta"), delta)
      : undefined;
  return {
    headSha: history.headSha,
    baseSha: history.baseSha,
    baseRef: pr.baseRefName || "",
    lastReviewId: history.lastReviewId,
    changedFiles: reviewScope(delta),
    rereview: history.previous !== null,
    previousSpecialists: history.previous?.specialists ?? null,
    block: formatPreviousReviewBlock(history, delta, deltaPaths),
    compactBlock: formatPreviousReviewBlock(history, delta, deltaPaths, 0),
  };
}
