// Publishes a review run's results (opt-in via the `rereview_context` input).
//
// Runs after OpenCode as its own step. The model writes its inline findings to
// a JSON file instead of calling the GitHub API, and OpenCode posts its final
// response as a new top-level comment. This step posts the findings as one
// review with an empty body, moves findings that cannot be anchored to a diff
// line into the summary, and folds the response into Bonk's single sticky
// review comment, stamped with the review-state marker.
//
// On re-reviews it also follows up on Bonk's own threads: it runs the thread
// actions the model wrote (reply, resolve, unresolve) on threads Bonk started,
// skips findings that already have a thread, and resolves Bonk's threads whose
// finding the model no longer reports, when nobody replied to them.

import { existsSync, readFileSync } from "fs";
import { pathToFileURL } from "url";
import { core } from "./context";
import { fetchWithRetry } from "./http";
import {
  SHA_PATTERN,
  botLogin,
  fetchReviewThreads,
  findStickyComment,
  formatReviewStateMarker,
  githubGraphQL,
  isBonk,
  splitRepository,
  stripOpencodeFooter,
  stripReviewState,
  type GraphQLAuthor,
  type GraphQLComment,
  type GraphQLReview,
  type ReviewThreadNode,
} from "./review-state";

// The harness guidance makes every review response start with one of these
// verdict lines. `LGTM` without the bang is accepted because repository prompts
// sometimes ask for it.
const REVIEW_VERDICT_PATTERN =
  /^\s*(?:LGTM!?(?=\s|$)|Review: \d+ findings?\.|Since last review: \d+ resolved, \d+ still open, \d+ new\.)/;
// A finding whose line is not in the diff moves to the nearest commentable
// line within this distance; farther away it could land on unrelated code.
const MAX_SNAP_DISTANCE = 5;
const SUGGESTION_PATTERN = /```suggestion\b/;

export type Side = "LEFT" | "RIGHT";

export interface Finding {
  path: string;
  line: number;
  startLine?: number;
  side: Side;
  body: string;
  // Set when the finding re-reports one of Bonk's earlier threads.
  threadId?: string;
}

export interface ThreadAction {
  threadId: string;
  action: "reply" | "resolve" | "unresolve";
  body?: string;
}

export interface ReviewFile {
  findings: Finding[];
  threadActions: ThreadAction[];
}

// A review thread Bonk started, as publishing sees it.
export interface BonkThread {
  id: string;
  resolved: boolean;
  path: string;
  line: number | null;
  hasHumanReplies: boolean;
  // The thread's first comment: the finding as Bonk posted it.
  body: string;
  url?: string;
}

// Written by preflight as the `review_state` output.
export interface PublishState {
  head: string;
  base: string;
  lastReviewId: number;
  // Files the author changed since the last review, or null when the review
  // covered the whole pull request.
  changedFiles: string[] | null;
  reviewFile: string;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

// The file is model output: keep only well-formed findings and never throw.
export function parseReviewFile(text: string): ReviewFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const findings: Finding[] = [];
  const rawFindings = (raw as { findings?: unknown }).findings;
  for (const item of Array.isArray(rawFindings) ? rawFindings : []) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const line = positiveInteger(entry.line);
    const startLine = positiveInteger(entry.start_line);
    if (typeof entry.path !== "string" || !entry.path || !line) continue;
    if (typeof entry.body !== "string" || !entry.body.trim()) continue;
    findings.push({
      path: entry.path,
      line,
      ...(startLine && startLine < line ? { startLine } : {}),
      side: entry.side === "LEFT" ? "LEFT" : "RIGHT",
      body: entry.body,
      ...(typeof entry.thread_id === "string" && entry.thread_id
        ? { threadId: entry.thread_id }
        : {}),
    });
  }
  const threadActions: ThreadAction[] = [];
  const rawActions = (raw as { thread_actions?: unknown }).thread_actions;
  for (const item of Array.isArray(rawActions) ? rawActions : []) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const action = entry.action;
    if (typeof entry.thread_id !== "string" || !entry.thread_id) continue;
    if (action !== "reply" && action !== "resolve" && action !== "unresolve") continue;
    const body = typeof entry.body === "string" && entry.body.trim() ? entry.body : undefined;
    if (action === "reply" && !body) continue;
    threadActions.push({ threadId: entry.thread_id, action, ...(body ? { body } : {}) });
  }
  return { findings, threadActions };
}

export function parsePublishState(text: string | undefined): PublishState | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Partial<PublishState>;
    if (typeof raw.head !== "string" || !SHA_PATTERN.test(raw.head)) return null;
    return {
      head: raw.head,
      base: typeof raw.base === "string" ? raw.base : "",
      lastReviewId: typeof raw.lastReviewId === "number" ? raw.lastReviewId : 0,
      changedFiles:
        Array.isArray(raw.changedFiles) &&
        raw.changedFiles.every((file) => typeof file === "string")
          ? raw.changedFiles
          : null,
      reviewFile: typeof raw.reviewFile === "string" ? raw.reviewFile : "",
    };
  } catch {
    return null;
  }
}

// Only review runs update the sticky summary and move the last reviewed head;
// a `/bonk explain` answer must stay a normal comment and must not hide
// unreviewed commits from the next review. Signals, most deterministic first:
// the model wrote the review file, the run was triggered by a pull_request
// event (which always asks for a review), Bonk submitted a review during the
// run, or the response starts with a verdict line.
export function isReviewRun(
  eventName: string,
  lastReviewId: number,
  reviewIds: number[],
  responseBody: string,
  wroteReviewFile = false,
): boolean {
  return (
    wroteReviewFile ||
    eventName === "pull_request" ||
    reviewIds.some((id) => id > lastReviewId) ||
    REVIEW_VERDICT_PATTERN.test(responseBody)
  );
}

// Lines a review comment can target, per file and side, with the hunk each
// line belongs to (a multi-line comment must stay within one hunk).
export type CommentableLines = Map<string, Record<Side, Map<number, number>>>;

export function parseCommentableLines(
  files: Array<{ filename: string; patch?: string }>,
): CommentableLines {
  const result: CommentableLines = new Map();
  for (const file of files) {
    const sides: Record<Side, Map<number, number>> = { LEFT: new Map(), RIGHT: new Map() };
    result.set(file.filename, sides);
    let left = 0;
    let right = 0;
    let hunk = -1;
    for (const line of (file.patch ?? "").split("\n")) {
      const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (header) {
        left = Number(header[1]);
        right = Number(header[2]);
        hunk += 1;
        continue;
      }
      if (hunk < 0 || line.startsWith("\\")) continue;
      if (line.startsWith("+")) {
        sides.RIGHT.set(right++, hunk);
      } else if (line.startsWith("-")) {
        sides.LEFT.set(left++, hunk);
      } else {
        sides.LEFT.set(left++, hunk);
        sides.RIGHT.set(right++, hunk);
      }
    }
  }
  return result;
}

function nearestLine(target: number, lines: Map<number, number>): number | null {
  for (let delta = 0; delta <= MAX_SNAP_DISTANCE; delta += 1) {
    if (lines.has(target + delta)) return target + delta;
    if (delta > 0 && lines.has(target - delta)) return target - delta;
  }
  return null;
}

// Returns the finding at a commentable position, or null when it belongs in
// the summary. Suggestions are never moved: a suggestion replaces exactly the
// lines it targets.
export function anchorFinding(finding: Finding, commentable: CommentableLines): Finding | null {
  const lines = commentable.get(finding.path)?.[finding.side];
  if (!lines) return null;
  const exact = lines.has(finding.line) && (!finding.startLine || lines.has(finding.startLine));
  if (exact) {
    if (finding.startLine && lines.get(finding.startLine) !== lines.get(finding.line)) {
      return null;
    }
    return finding;
  }
  if (SUGGESTION_PATTERN.test(finding.body)) return null;
  const line = nearestLine(finding.line, lines);
  if (line === null) return null;
  return { path: finding.path, line, side: finding.side, body: finding.body };
}

export function formatUnanchoredFindings(findings: Finding[], reason: string): string {
  if (findings.length === 0) return "";
  const items = findings.map((finding) => {
    const location = finding.startLine
      ? `${finding.path}:${finding.startLine}-${finding.line}`
      : `${finding.path}:${finding.line}`;
    const body = finding.body.trim().replace(/\n/g, "\n  ");
    return `- \`${location}\`: ${body}`;
  });
  return [`**${reason}**`, "", ...items].join("\n");
}

export interface StickyBodyParts {
  summary: string;
  unanchored: string;
  head: string;
  base: string;
  liveHead: string;
  stale: boolean;
  commitUrl: string;
  runUrl: string;
}

// The review, then a footer naming the reviewed commit, then the hidden marker
// as the last line, after all model-written text.
export function buildStickyBody(parts: StickyBodyParts): string {
  const sections = [parts.summary.trim()];
  if (parts.unanchored) sections.push(parts.unanchored);
  if (parts.stale) {
    sections.push(
      `> [!NOTE]\n> This response reflects ${parts.head.slice(0, 12)}; the pull request head has since moved to ${parts.liveHead.slice(0, 12)}.`,
    );
  }
  const footer = `<sub>Reviewed commit: [${parts.head.slice(0, 8)}](${parts.commitUrl}) · [github run](${parts.runUrl})</sub>`;
  return `${sections.join("\n\n")}\n\n---\n${footer}\n\n${formatReviewStateMarker({ head: parts.head, base: parts.base })}`;
}

async function githubRest(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetchWithRetry(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function fetchCommentableLines(
  token: string,
  repository: string,
  prNumber: string,
): Promise<CommentableLines> {
  const files: Array<{ filename: string; patch?: string }> = [];
  for (let page = 1; page <= 30; page += 1) {
    const resp = await githubRest(
      token,
      "GET",
      `/repos/${repository}/pulls/${prNumber}/files?per_page=100&page=${page}`,
    );
    if (!resp.ok) throw new Error(`Listing pull request files returned ${resp.status}`);
    const batch = (await resp.json()) as Array<{ filename: string; patch?: string }>;
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return parseCommentableLines(files);
}

// Posts anchored findings as one review with an empty body, pinned to the
// reviewed commit. Returns the findings GitHub rejected.
async function postFindings(
  token: string,
  repository: string,
  prNumber: string,
  head: string,
  findings: Finding[],
): Promise<Finding[]> {
  if (findings.length === 0) return [];
  const resp = await githubRest(token, "POST", `/repos/${repository}/pulls/${prNumber}/reviews`, {
    commit_id: head,
    event: "COMMENT",
    body: "",
    comments: findings.map((finding) => ({
      path: finding.path,
      line: finding.line,
      side: finding.side,
      ...(finding.startLine ? { start_line: finding.startLine, start_side: finding.side } : {}),
      body: finding.body,
    })),
  });
  if (resp.ok) {
    core.info(`Posted ${findings.length} inline finding(s)`);
    return [];
  }
  // GitHub rejects the whole review if any comment is invalid; keep every
  // finding visible in the summary rather than dropping them.
  core.warning(`Posting inline findings failed (${resp.status}): ${await resp.text()}`);
  return findings;
}

function normalizeFindingText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

// A re-reported finding names its thread by id. The fallback only catches a
// finding copied verbatim onto the same line of the same file without its id;
// anything less certain is a new finding and gets posted.
function matchThread(finding: Finding, threads: Map<string, BonkThread>): BonkThread | undefined {
  if (finding.threadId) {
    const thread = threads.get(finding.threadId);
    if (!thread)
      core.warning(`Finding names unknown thread ${finding.threadId}; posting it as new`);
    return thread;
  }
  const text = normalizeFindingText(finding.body);
  for (const thread of threads.values()) {
    if (
      thread.path === finding.path &&
      thread.line === finding.line &&
      normalizeFindingText(thread.body) === text
    ) {
      return thread;
    }
  }
  return undefined;
}

export interface Partition {
  // New findings, to post inline or list in the summary.
  toPost: Finding[];
  // Re-reported findings whose thread is resolved; listed in the summary so
  // they stay visible without reopening a thread a person closed.
  stillPresent: Array<{ finding: Finding; thread: BonkThread }>;
  // Open threads re-reported by a finding; they stay as they are.
  kept: BonkThread[];
  toResolve: BonkThread[];
}

// Deterministic safety net around the model's judgement. No finding is
// dropped: each one either keeps its open thread, is listed in the summary,
// or is posted. An open Bonk thread that no finding references is resolved,
// but only when nobody replied to it, the model did not act on it, and its
// file was part of this review: a file the author did not touch cannot have
// been fixed.
export function partitionFindings(
  findings: Finding[],
  threads: BonkThread[],
  actedOn: ReadonlySet<string>,
  changedFiles: string[] | null,
): Partition {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const referenced = new Set<string>();
  const result: Partition = { toPost: [], stillPresent: [], kept: [], toResolve: [] };
  for (const finding of findings) {
    const thread = matchThread(finding, byId);
    if (!thread) {
      result.toPost.push(finding);
    } else if (thread.resolved) {
      result.stillPresent.push({ finding, thread });
    } else if (!referenced.has(thread.id)) {
      result.kept.push(thread);
    }
    if (thread) referenced.add(thread.id);
  }
  const inScope = (path: string) => changedFiles === null || changedFiles.includes(path);
  result.toResolve = threads.filter(
    (thread) =>
      !thread.resolved &&
      !referenced.has(thread.id) &&
      !actedOn.has(thread.id) &&
      !thread.hasHumanReplies &&
      inScope(thread.path),
  );
  return result;
}

export function formatStillPresent(entries: Partition["stillPresent"]): string {
  if (entries.length === 0) return "";
  const items = entries.map(({ finding, thread }) => {
    const location = `${finding.path}:${finding.line}`;
    const link = thread.url ? `[\`${location}\`](${thread.url})` : `\`${location}\``;
    return `- ${link}: ${finding.body.trim().replace(/\n/g, "\n  ")}`;
  });
  return ["**Earlier findings still present (thread resolved)**", "", ...items].join("\n");
}

const REPLY_MUTATION = `
mutation($id: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) {
    comment { id }
  }
}`;
const RESOLVE_MUTATION = `
mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`;
const UNRESOLVE_MUTATION = `
mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id } } }`;

async function runMutation(
  token: string,
  mutation: string,
  variables: Record<string, unknown>,
  description: string,
): Promise<boolean> {
  try {
    await githubGraphQL(token, mutation, variables);
    return true;
  } catch (error) {
    core.warning(`Failed to ${description}: ${error}`);
    return false;
  }
}

// Runs the model's thread actions on threads Bonk started; any other thread id
// is ignored, however the model came by it. Unresolves run first and resolves
// last, so a reply lands before its thread closes.
// Returns the ids of the threads acted on and updates their resolved state.
export async function executeThreadActions(
  token: string,
  actions: ThreadAction[],
  threads: BonkThread[],
): Promise<Set<string>> {
  const owned = new Map(threads.map((thread) => [thread.id, thread]));
  const seen = new Set<string>();
  const accepted: ThreadAction[] = [];
  for (const action of actions) {
    const key = `${action.action}:${action.threadId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!owned.has(action.threadId)) {
      core.warning(`Ignoring ${action.action} on thread ${action.threadId}: Bonk did not start it`);
      continue;
    }
    accepted.push(action);
  }

  const actedOn = new Set<string>();
  const order: ThreadAction["action"][] = ["unresolve", "reply", "resolve"];
  for (const kind of order) {
    for (const action of accepted.filter((candidate) => candidate.action === kind)) {
      const thread = owned.get(action.threadId)!;
      actedOn.add(thread.id);
      if (kind === "unresolve" && thread.resolved) {
        if (await runMutation(token, UNRESOLVE_MUTATION, { id: thread.id }, "unresolve a thread")) {
          thread.resolved = false;
        }
      }
      if (action.body) {
        await runMutation(
          token,
          REPLY_MUTATION,
          { id: thread.id, body: action.body },
          "reply on a thread",
        );
      }
      if (kind === "resolve" && !thread.resolved) {
        if (await runMutation(token, RESOLVE_MUTATION, { id: thread.id }, "resolve a thread")) {
          thread.resolved = true;
        }
      }
    }
  }
  return actedOn;
}

export function bonkThreads(nodes: ReviewThreadNode[], login: string): BonkThread[] {
  const threads: BonkThread[] = [];
  for (const node of nodes) {
    const [first, ...replies] = node.comments?.nodes ?? [];
    if (!node.id || !first || !isBonk(first.author, login)) continue;
    threads.push({
      id: node.id,
      resolved: Boolean(node.isResolved),
      path: node.path || "",
      line: node.line ?? node.originalLine ?? null,
      // Replies that were not fetched may be a person's, so count them as one.
      hasHumanReplies:
        Boolean(node.omittedReplies) || replies.some((reply) => !isBonk(reply.author, login)),
      body: first.body || "",
      ...(first.url ? { url: first.url } : {}),
    });
  }
  return threads;
}

function readReviewFile(path: string): ReviewFile | null {
  if (!path || !existsSync(path)) return null;
  const parsed = parseReviewFile(readFileSync(path, "utf8"));
  if (!parsed) core.warning(`Ignoring malformed review file ${path}`);
  return parsed;
}

const PUBLISH_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      comments(last: 100) { nodes { databaseId author { __typename login } body } }
      reviews(last: 20) { nodes { databaseId author { __typename login } } }
    }
  }
}`;

interface PublishPullRequest {
  headRefOid?: string;
  comments?: { nodes?: GraphQLComment[] };
  reviews?: { nodes?: GraphQLReview[] };
}

// Best-effort: runs after OpenCode and never fails the job.
export async function publishReview(): Promise<void> {
  const token = process.env.GH_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY || "";
  const prNumber = process.env.PR_NUMBER || "";
  const runId = process.env.GITHUB_RUN_ID || "";
  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const state = parsePublishState(process.env.REVIEW_STATE);
  if (!token || !repository || !prNumber || !runId || !state) {
    core.info("Review publishing context incomplete; skipping.");
    return;
  }

  const { owner, repo } = splitRepository(repository);
  const data = await githubGraphQL<{
    viewer?: GraphQLAuthor | null;
    repository?: { pullRequest?: PublishPullRequest | null };
  }>(token, PUBLISH_QUERY, { owner, repo, number: Number.parseInt(prNumber, 10) });
  const pr = data.repository?.pullRequest;
  const login = botLogin(data.viewer);
  const comments = pr?.comments?.nodes ?? [];

  // opencode links every response it posts to the run that produced it, so
  // the run URL identifies this run's comment among Bonk's comments.
  const runLink = `/${repository}/actions/runs/${runId})`;
  const response = comments
    .toReversed()
    .find((comment) => isBonk(comment.author, login) && comment.body?.includes(runLink));
  if (!response?.databaseId || !response.body) {
    core.info("No Bonk response for this run found; skipping review publishing.");
    return;
  }

  const reviewFile = readReviewFile(state.reviewFile);
  const reviewIds = (pr?.reviews?.nodes ?? [])
    .filter((review) => isBonk(review.author, login))
    .map((review) => review.databaseId ?? 0);
  if (
    !isReviewRun(
      process.env.EVENT_NAME || "",
      state.lastReviewId,
      reviewIds,
      response.body,
      reviewFile !== null,
    )
  ) {
    core.info("This run did not review the pull request; leaving its response as is.");
    return;
  }

  // When OpenCode pushed this run's own changes, the workspace HEAD is the new
  // PR head; that is not a newer push by someone else.
  const liveHead = pr?.headRefOid || "";
  const stale =
    Boolean(liveHead) && liveHead !== state.head && liveHead !== process.env.WORKSPACE_HEAD_SHA;

  const findings = reviewFile?.findings ?? [];
  let stillPresent = "";
  let unanchored: Finding[] = [];
  let unanchoredReason = "Findings outside the diff";
  if (stale) {
    // Line numbers refer to a head that is no longer current.
    unanchored = findings;
    unanchoredReason = "Findings not posted inline because the pull request changed";
  } else if (reviewFile) {
    const threads = bonkThreads(await fetchReviewThreads(token, repository, prNumber), login);
    const actedOn = await executeThreadActions(token, reviewFile.threadActions, threads);
    const partition = partitionFindings(findings, threads, actedOn, state.changedFiles);
    const { toPost, toResolve } = partition;
    stillPresent = formatStillPresent(partition.stillPresent);
    for (const thread of toResolve) {
      await runMutation(token, RESOLVE_MUTATION, { id: thread.id }, "resolve a stale thread");
    }
    const commentable =
      toPost.length > 0 ? await fetchCommentableLines(token, repository, prNumber) : new Map();
    const anchored: Finding[] = [];
    for (const finding of toPost) {
      const position = anchorFinding(finding, commentable);
      if (position) anchored.push(position);
      else unanchored.push(finding);
    }
    unanchored.push(...(await postFindings(token, repository, prNumber, state.head, anchored)));
  }

  const body = buildStickyBody({
    summary: stripOpencodeFooter(stripReviewState(response.body)),
    unanchored: [stillPresent, formatUnanchoredFindings(unanchored, unanchoredReason)]
      .filter(Boolean)
      .join("\n\n"),
    head: state.head,
    base: state.base,
    liveHead,
    stale,
    commitUrl: `${serverUrl}/${repository}/commit/${state.head}`,
    runUrl: `${serverUrl}/${repository}/actions/runs/${runId}`,
  });

  // One review summary per pull request: the newest Bonk comment carrying a
  // review-state marker is edited in place, and this run's response goes.
  const sticky = await findStickyComment(token, repository, prNumber, login, response.databaseId);
  const target = sticky?.databaseId ?? response.databaseId;
  const patched = await githubRest(
    token,
    "PATCH",
    `/repos/${repository}/issues/comments/${target}`,
    { body },
  );
  if (!patched.ok) {
    core.warning(
      `Failed to update the review summary (${patched.status}): ${await patched.text()}`,
    );
    return;
  }
  core.info(`Updated review summary ${target} for ${state.head}`);
  if (target === response.databaseId) return;

  const deleted = await githubRest(
    token,
    "DELETE",
    `/repos/${repository}/issues/comments/${response.databaseId}`,
  );
  if (!deleted.ok) {
    core.warning(`Failed to remove the duplicate response (${deleted.status})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publishReview().catch((error) => {
    core.warning(`Failed to publish review: ${error}`);
  });
}
