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
import { relative, resolve } from "path";
import { pathToFileURL } from "url";
import { core } from "./context";
import { fetchPullRequestFiles, isTestPath, readManifest, readPatch } from "./review-diff";
import { fetchWithRetry } from "./http";
import {
  SHA_PATTERN,
  botLogin,
  fetchBonkReviews,
  fetchReviewThreads,
  findStickyComment,
  formatReviewStateMarker,
  githubGraphQL,
  isBonk,
  parseReviewStateMarker,
  splitRepository,
  stripOpencodeFooter,
  stripReviewState,
  type GraphQLAuthor,
  type GraphQLComment,
  type ReviewThreadNode,
} from "./review-state";

// The harness guidance makes every review response start with one of these
// verdict lines. `LGTM` without the bang is accepted because repository prompts
// sometimes ask for it.
const REVIEW_VERDICT_PATTERN =
  /^\s*(?:LGTM!?(?=\s|$)|Review: \d+ findings?(?: \([^)\n]*\))?\.|Since last review: \d+ resolved, \d+ still open, \d+ new\.)/;
const VERDICT_LINE_PATTERN =
  /^(?:LGTM!?|Review: \d+ findings?(?: \([^)\n]*\))?\.|Since last review: \d+ resolved, \d+ still open, \d+ new\.)\s*$/;
// A finding whose line is not in the diff moves to the nearest commentable
// line within this distance; farther away it could land on unrelated code.
const MAX_SNAP_DISTANCE = 5;
const SUGGESTION_PATTERN = /```suggestion\b/;

export type Side = "LEFT" | "RIGHT";

// Most severe first. Blocking and warning findings are defects the author
// should act on and go inline; info, suggestion, and question findings are
// listed in the summary so the diff only carries what needs a change.
export const SEVERITIES = ["blocking", "warning", "info", "suggestion", "question"] as const;
export type Severity = (typeof SEVERITIES)[number];
const INLINE_SEVERITIES: ReadonlySet<Severity> = new Set(["blocking", "warning"]);

export interface RuleQuote {
  path: string;
  text: string;
}

export interface Finding {
  // Empty for a finding about the change as a whole.
  path: string;
  // Absent for a finding that is not about a specific line.
  line?: number;
  startLine?: number;
  side: Side;
  body: string;
  severity: Severity;
  // The code carries an explicit comment justifying what the finding flags.
  justified?: boolean;
  // A rule or standard the finding cites, quoted from a repository file.
  quote?: RuleQuote;
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
  // Bonk replied on the thread after posting the finding, i.e. an earlier
  // review already followed up on it.
  bonkReplied?: boolean;
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
  // Bonk reviewed this pull request before.
  rereview: boolean;
  // The request is a review (a pull_request event, or a request that asks for
  // one), so a run that ends without one has failed.
  expectReview: boolean;
  reviewFile: string;
  // Where preflight wrote the pull request diff; empty when it did not.
  diffDir: string;
  // Repository specialist definitions from the base commit; empty if none.
  specialistsDir: string;
  // Specialist statuses recorded with the last review.
  previousSpecialists: Record<string, string> | null;
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
    const path = typeof entry.path === "string" ? entry.path : "";
    const line = path ? positiveInteger(entry.line) : undefined;
    const startLine = line ? positiveInteger(entry.start_line) : undefined;
    if (typeof entry.body !== "string" || !entry.body.trim()) continue;
    const severity = String(entry.severity ?? "").toLowerCase() as Severity;
    const quote = entry.quote as Partial<RuleQuote> | undefined;
    findings.push({
      path,
      ...(line ? { line } : {}),
      ...(startLine && line && startLine < line ? { startLine } : {}),
      side: entry.side === "LEFT" ? "LEFT" : "RIGHT",
      body: entry.body,
      severity: SEVERITIES.includes(severity) ? severity : "warning",
      ...(entry.justified === true ? { justified: true } : {}),
      ...(quote &&
      typeof quote.path === "string" &&
      typeof quote.text === "string" &&
      quote.text.trim()
        ? { quote: { path: quote.path, text: quote.text } }
        : {}),
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
      rereview: raw.rereview === true,
      expectReview: raw.expectReview === true,
      reviewFile: typeof raw.reviewFile === "string" ? raw.reviewFile : "",
      diffDir: typeof raw.diffDir === "string" ? raw.diffDir : "",
      specialistsDir: typeof raw.specialistsDir === "string" ? raw.specialistsDir : "",
      previousSpecialists:
        raw.previousSpecialists &&
        typeof raw.previousSpecialists === "object" &&
        !Array.isArray(raw.previousSpecialists)
          ? raw.previousSpecialists
          : null,
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
  if (!lines || !finding.line) return null;
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
  const { startLine: _dropped, ...single } = finding;
  return { ...single, line };
}

function findingLocation(finding: Finding): string {
  if (!finding.path) return "";
  if (!finding.line) return finding.path;
  return finding.startLine
    ? `${finding.path}:${finding.startLine}-${finding.line}`
    : `${finding.path}:${finding.line}`;
}

function severityTag(severity: Severity): string {
  return `**[${severity.toUpperCase()}]**`;
}

function renderQuote(quote: RuleQuote | undefined): string {
  if (!quote) return "";
  const lines = quote.text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`);
  return `\n\n${lines.join("\n")}\n>\n> — \`${quote.path}\``;
}

// The body of an inline review comment.
export function renderFinding(finding: Finding): string {
  return `${severityTag(finding.severity)} ${finding.body.trim()}${renderQuote(finding.quote)}`;
}

export function formatFindingList(
  findings: Finding[],
  title: string,
  link?: (finding: Finding) => string | undefined,
): string {
  if (findings.length === 0) return "";
  const items = findings.map((finding) => {
    const location = findingLocation(finding);
    const url = link?.(finding);
    const where = location ? (url ? ` [\`${location}\`](${url}):` : ` \`${location}\`:`) : "";
    const text = `${finding.body.trim()}${renderQuote(finding.quote)}`.replace(/\n/g, "\n  ");
    return `- ${severityTag(finding.severity)}${where} ${text}`;
  });
  return [`**${title}**`, "", ...items].join("\n");
}

const DEMOTION: Record<Severity, Severity> = {
  blocking: "warning",
  warning: "info",
  info: "suggestion",
  suggestion: "suggestion",
  question: "question",
};

// Checks that a quoted rule appears verbatim in the repository file it names.
export function verifyQuote(quote: RuleQuote, workspace: string): boolean {
  const file = resolve(workspace, quote.path);
  const inside = relative(workspace, file);
  if (!inside || inside.startsWith("..") || resolve(workspace, inside) !== file) return false;
  try {
    const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
    return normalize(readFileSync(file, "utf8")).includes(normalize(quote.text));
  } catch {
    return false;
  }
}

// Severity rules the model is told about, applied in code so they hold
// regardless: a finding drops one level when the code carries an explicit
// justification, never below suggestion, and a finding in a test file is
// dropped unless it is still blocking or a warning, so reviews do not ask for
// churn in test code nobody would change. A review asks at most one question;
// further questions become info. A quoted rule that does not appear verbatim
// in the file it names is removed.
export function applySeverityRules(findings: Finding[], workspace: string): Finding[] {
  let asked = false;
  return findings.flatMap((finding) => {
    let severity = finding.severity;
    if (severity === "question") {
      if (asked) severity = "info";
      asked = true;
    }
    if (finding.justified) severity = DEMOTION[severity];
    if (finding.path && isTestPath(finding.path) && !INLINE_SEVERITIES.has(severity)) {
      core.info(`Dropping a ${severity} finding in test file ${finding.path}`);
      return [];
    }
    let quote = finding.quote;
    if (quote && !verifyQuote(quote, workspace)) {
      core.warning(`Dropping a quote not found verbatim in ${quote.path}`);
      quote = undefined;
    }
    const { quote: _original, ...rest } = finding;
    return [{ ...rest, severity, ...(quote ? { quote } : {}) }];
  });
}

export function isInline(finding: Finding): boolean {
  return INLINE_SEVERITIES.has(finding.severity);
}

function plural(count: number, severity: Severity): string {
  if (severity === "blocking" || severity === "info") return `${count} ${severity}`;
  return `${count} ${severity}${count === 1 ? "" : "s"}`;
}

export interface VerdictCounts {
  findings: Finding[];
  // Re-reviews only.
  resolved?: number;
  stillOpen?: number;
  added?: number;
}

// The verdict line comes from the findings, not from the model's text, so the
// counts always match what was posted. Only blocking findings and warnings
// count as findings; info, suggestions and questions are notes, which do not
// stand between a pull request and LGTM.
export function computeVerdict(counts: VerdictCounts, rereview: boolean): string {
  const serious = counts.findings.filter(isInline);
  const total = serious.length;
  const notes = counts.findings.length - total;
  const noteText = `${notes} note${notes === 1 ? "" : "s"}`;
  if (rereview) {
    const line = `Since last review: ${counts.resolved ?? 0} resolved, ${counts.stillOpen ?? 0} still open, ${counts.added ?? 0} new.`;
    return total === 0 ? `${line}\nLGTM!` : line;
  }
  if (total === 0) return "LGTM!";
  const breakdown = SEVERITIES.map(
    (severity) =>
      [
        severity,
        serious.filter((finding) => finding.severity === severity).length,
      ] as const,
  )
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => plural(count, severity));
  const extra = notes > 0 ? `; ${noteText}` : "";
  return `Review: ${total} finding${total === 1 ? "" : "s"} (${breakdown.join(", ")}${extra}).`;
}

// Drops the model's own verdict lines from the top of its response.
export function stripVerdict(text: string): string {
  const lines = text.trim().split("\n");
  while (lines.length > 0 && (VERDICT_LINE_PATTERN.test(lines[0].trim()) || !lines[0].trim())) {
    lines.shift();
  }
  return lines.join("\n").trim();
}

// A review summary Bonk posted before it kept a review-state marker: posted
// by opencode (it ends with the run link) and opening like a review, with a
// verdict line or Bonk's review greeting. Answers to other requests do not.
export function isEarlierSummary(body: string): boolean {
  const text = stripOpencodeFooter(body);
  if (text === body) return false;
  return REVIEW_VERDICT_PATTERN.test(text) || /^\s*I'm Bonk\b[^\n]*\breview/i.test(text);
}

export function parseSpecialistStatuses(
  text: string | undefined,
): Record<string, { status: string; reason?: string }> {
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const statuses: Record<string, { status: string; reason?: string }> = {};
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = value as { status?: unknown; reason?: unknown };
      if (typeof entry?.status !== "string") continue;
      statuses[name] = {
        status: entry.status,
        ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
      };
    }
    return statuses;
  } catch {
    return {};
  }
}

const REVIEWED_STATUSES = new Set(["ok", "issues", "partial"]);
export const CARRIED_FORWARD = "carried forward";

// Specialists that did not finish are named in the summary, so a missing
// area is visible rather than silently absent; so are specialists whose
// earlier result was reused because the author did not touch their files.
export function formatNotReviewed(
  statuses: Record<string, { status: string; reason?: string }>,
): string {
  const entries = Object.entries(statuses);
  const carried = entries
    .filter(([, entry]) => entry.reason === CARRIED_FORWARD)
    .map(([name]) => name);
  const missing = entries.filter(([, entry]) => !REVIEWED_STATUSES.has(entry.status));
  const sections: string[] = [];
  if (missing.length > 0) {
    sections.push(
      [
        "**Not reviewed**",
        "",
        ...missing.map(
          ([name, entry]) =>
            `- ${name}: not reviewed (${entry.reason ?? entry.status.replace(/_/g, " ")})`,
        ),
      ].join("\n"),
    );
  }
  if (carried.length > 0) {
    sections.push(
      `**Carried forward from the last review:** ${carried.join(", ")} (no author changes in their files since then; earlier findings stand)`,
    );
  }
  return sections.join("\n\n");
}

export interface StickyBodyParts {
  specialists?: Record<string, string>;
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
  return `${sections.join("\n\n")}\n\n---\n${footer}\n\n${formatReviewStateMarker({ head: parts.head, base: parts.base, specialists: parts.specialists })}`;
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

// Places comments on the hunks preflight wrote for the prompt, so the model
// and the publisher agree on the diff. Without a manifest (no RUNNER_TEMP) it
// lists the files from GitHub. Filtered files have no patch and so no
// commentable lines; their findings go to the summary.
async function loadCommentableLines(
  token: string,
  repository: string,
  prNumber: string,
  diffDir: string,
): Promise<CommentableLines> {
  const manifest = readManifest(diffDir);
  if (manifest) {
    return parseCommentableLines(
      manifest.files.map((file) => ({ filename: file.path, patch: readPatch(file) })),
    );
  }
  const { files } = await fetchPullRequestFiles(token, repository, prNumber);
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
      body: renderFinding(finding),
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
  if (!finding.line) return undefined;
  for (const thread of threads.values()) {
    if (
      thread.path === finding.path &&
      thread.line === finding.line &&
      normalizeFindingText(thread.body).replace(/^\*\*\[[a-z]+\]\*\* /, "") === text
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
  const urls = new Map(entries.map(({ finding, thread }) => [finding, thread.url]));
  return formatFindingList(
    entries.map((entry) => entry.finding),
    "Earlier findings still present (thread resolved)",
    (finding) => urls.get(finding),
  );
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

export interface ThreadActionResult {
  // Threads the model acted on.
  actedOn: Set<string>;
  // Earlier findings this run confirmed fixed: threads it resolved, and
  // threads a person resolved before Bonk followed up on them, which the
  // model confirmed with a resolve action.
  resolved: Set<string>;
}

// Runs the model's thread actions on threads Bonk started; any other thread id
// is ignored, however the model came by it. Unresolves run first and resolves
// last, so a reply lands before its thread closes. Updates the threads'
// resolved state.
export async function executeThreadActions(
  token: string,
  actions: ThreadAction[],
  threads: BonkThread[],
): Promise<ThreadActionResult> {
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
  const resolved = new Set<string>();
  const order: ThreadAction["action"][] = ["unresolve", "reply", "resolve"];
  for (const kind of order) {
    for (const action of accepted.filter((candidate) => candidate.action === kind)) {
      const thread = owned.get(action.threadId)!;
      actedOn.add(thread.id);
      // A person resolved the thread. If Bonk already followed up on it in an
      // earlier review, confirming the fix again would only repeat itself.
      const confirming = kind === "resolve" && thread.resolved;
      if (confirming && thread.bonkReplied) {
        core.info(`Thread ${thread.id} is resolved and Bonk already followed up on it`);
        continue;
      }
      if (kind === "unresolve" && thread.resolved) {
        if (await runMutation(token, UNRESOLVE_MUTATION, { id: thread.id }, "unresolve a thread")) {
          thread.resolved = false;
        }
      }
      let replied = true;
      if (action.body) {
        replied = await runMutation(
          token,
          REPLY_MUTATION,
          { id: thread.id, body: action.body },
          "reply on a thread",
        );
      }
      if (confirming) {
        if (replied) resolved.add(thread.id);
      } else if (kind === "resolve") {
        if (await runMutation(token, RESOLVE_MUTATION, { id: thread.id }, "resolve a thread")) {
          thread.resolved = true;
          resolved.add(thread.id);
        }
      }
    }
  }
  return { actedOn, resolved };
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
      bonkReplied: replies.some((reply) => isBonk(reply.author, login)),
      body: first.body || "",
      ...(first.url ? { url: first.url } : {}),
    });
  }
  return threads;
}

// A review is complete when the model wrote a valid findings file, or at
// least answered with a verdict line (repository prompts written before the
// file existed may skip it). Anything else is a failed attempt.
export function reviewCompleted(
  reviewFile: ReviewFile | null,
  responseBody: string | undefined,
): boolean {
  return reviewFile !== null || REVIEW_VERDICT_PATTERN.test(responseBody ?? "");
}

const RUN_RESPONSE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      comments(last: 50) { nodes { databaseId author { __typename login } body } }
    }
  }
}`;

// opencode links every response it posts to the run that produced it, so the
// run URL identifies this run's newest comment among Bonk's comments.
export async function findRunResponse(
  token: string,
  repository: string,
  prNumber: string,
  runId: string,
): Promise<{ login: string; response: GraphQLComment | null }> {
  const { owner, repo } = splitRepository(repository);
  const data = await githubGraphQL<{
    viewer?: GraphQLAuthor | null;
    repository?: { pullRequest?: { comments?: { nodes?: GraphQLComment[] } } | null };
  }>(token, RUN_RESPONSE_QUERY, { owner, repo, number: Number.parseInt(prNumber, 10) });
  const login = botLogin(data.viewer);
  const runLink = `/${repository}/actions/runs/${runId})`;
  const response =
    (data.repository?.pullRequest?.comments?.nodes ?? [])
      .toReversed()
      .find((comment) => isBonk(comment.author, login) && comment.body?.includes(runLink)) ?? null;
  return { login, response };
}

export async function deleteComment(
  token: string,
  repository: string,
  id: number,
): Promise<boolean> {
  const resp = await githubRest(token, "DELETE", `/repos/${repository}/issues/comments/${id}`);
  return resp.ok;
}

export function readReviewFile(path: string): ReviewFile | null {
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
    }
  }
}`;

interface PublishPullRequest {
  headRefOid?: string;
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
  const { login, response } = await findRunResponse(token, repository, prNumber, runId);
  if (!response?.databaseId || !response.body) {
    core.info("No Bonk response for this run found; skipping review publishing.");
    return;
  }

  const reviewFile = readReviewFile(state.reviewFile);
  const reviewIds = (
    await fetchBonkReviews(token, repository, prNumber, login, state.lastReviewId)
  ).map((review) => review.databaseId ?? 0);
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
  // run-opencode.ts already fails such runs; never publish their text as the
  // review summary if one slips through.
  if (state.expectReview && !reviewCompleted(reviewFile, response.body)) {
    core.warning("The run ended without a review; leaving the previous summary untouched.");
    return;
  }

  // When OpenCode pushed this run's own changes, the workspace HEAD is the new
  // PR head; that is not a newer push by someone else.
  const liveHead = pr?.headRefOid || "";
  const stale =
    Boolean(liveHead) && liveHead !== state.head && liveHead !== process.env.WORKSPACE_HEAD_SHA;

  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const findings = applySeverityRules(reviewFile?.findings ?? [], workspace);
  const sections: string[] = [];
  let summary = stripOpencodeFooter(stripReviewState(response.body));
  if (stale) {
    // Line numbers refer to a head that is no longer current.
    sections.push(
      formatFindingList(findings, "Findings not posted inline because the pull request changed"),
    );
    if (reviewFile) {
      const reReported = findings.filter((finding) => finding.threadId).length;
      const verdict = computeVerdict(
        { findings, resolved: 0, stillOpen: reReported, added: findings.length - reReported },
        state.rereview,
      );
      summary = [verdict, stripVerdict(summary)].filter(Boolean).join("\n\n");
    }
  } else if (reviewFile) {
    const threads = bonkThreads(await fetchReviewThreads(token, repository, prNumber), login);
    const { actedOn, resolved } = await executeThreadActions(
      token,
      reviewFile.threadActions,
      threads,
    );
    const partition = partitionFindings(findings, threads, actedOn, state.changedFiles);
    for (const thread of partition.toResolve) {
      if (await runMutation(token, RESOLVE_MUTATION, { id: thread.id }, "resolve a stale thread")) {
        thread.resolved = true;
        resolved.add(thread.id);
      }
    }

    const inline = partition.toPost.filter(isInline);
    const commentable =
      inline.length > 0
        ? await loadCommentableLines(token, repository, prNumber, state.diffDir)
        : new Map();
    const anchored: Finding[] = [];
    const unanchored: Finding[] = [];
    for (const finding of inline) {
      const position = anchorFinding(finding, commentable);
      if (position) anchored.push(position);
      else unanchored.push(finding);
    }
    unanchored.push(...(await postFindings(token, repository, prNumber, state.head, anchored)));

    sections.push(
      formatFindingList(unanchored, "Findings outside the diff"),
      formatFindingList(
        partition.toPost.filter((finding) => !isInline(finding)),
        "Other findings",
      ),
      formatStillPresent(partition.stillPresent),
    );
    summary = [
      computeVerdict(
        {
          findings,
          resolved: resolved.size,
          stillOpen: partition.kept.length + partition.stillPresent.length,
          added: partition.toPost.length,
        },
        state.rereview,
      ),
      stripVerdict(summary),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const specialistStatuses = parseSpecialistStatuses(process.env.SPECIALIST_STATUS);
  sections.push(formatNotReviewed(specialistStatuses));

  const body = buildStickyBody({
    specialists: Object.fromEntries(
      Object.entries(specialistStatuses).map(([name, entry]) => [name, entry.status]),
    ),
    summary,
    unanchored: sections.filter(Boolean).join("\n\n"),
    head: state.head,
    base: state.base,
    liveHead,
    stale,
    commitUrl: `${serverUrl}/${repository}/commit/${state.head}`,
    runUrl: `${serverUrl}/${repository}/actions/runs/${runId}`,
  });

  // One review summary per pull request: the newest Bonk comment carrying a
  // review-state marker is edited in place, and this run's response goes.
  // Before the first marker, an earlier review summary is taken over so the
  // pull request does not keep an outdated one next to the new one.
  const sticky = await findStickyComment(
    token,
    repository,
    prNumber,
    login,
    response.databaseId,
    (comment) => isEarlierSummary(comment.body || ""),
  );
  if (sticky?.databaseId && !parseReviewStateMarker(sticky.body || "")) {
    core.info(`Taking over earlier review summary ${sticky.databaseId}`);
  }
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

  if (!(await deleteComment(token, repository, response.databaseId))) {
    core.warning("Failed to remove the duplicate response");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publishReview().catch((error) => {
    core.warning(`Failed to publish review: ${error}`);
  });
}
