// Specialist reviewers (opt-in via `rereview_context`, controlled by `specialists`).
//
// Before the main `opencode github run`, this step launches one
// `opencode run --agent <specialist>` process per selected specialist, in
// parallel. Each one sees only the patches in its scope, runs read-only with
// no GitHub token, and writes findings in the review-file schema. The main run
// then acts as the judge: it verifies, deduplicates, and corrects those
// findings and writes the single findings file the publisher posts.
//
// Selection is decided here from the diff manifest and a size tier, not by a
// model, so which areas get reviewed is predictable.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { appendGitHubValue, core, escapePromptValue } from "./context";
import { fetchWithRetry } from "./http";
import {
  compileGlob,
  neutralizeTags,
  readManifest,
  readPatch,
  type Category,
  type DiffFile,
  type DiffManifest,
} from "./review-diff";
import {
  CARRIED_FORWARD,
  parsePublishState,
  parseReviewFile,
  type Finding,
} from "./review-publish";

const MINUTE = 60_000;
const DEFAULT_BUDGET_MS = 5 * MINUTE;
const DEEP_BUDGET_MS = 10 * MINUTE;
const DEFAULT_STEP_TIMEOUT_MS = 15 * MINUTE;
const DEFAULT_PARALLELISM = 4;
// A specialist that emits nothing for this long between model steps has
// stalled. Inside a step, silence can be a thinking model before its first
// token or a long tool call, so it gets twice as long.
export const STALL_MS = 3 * MINUTE;
const MAX_ATTEMPTS = 2;
const SPECIALIST_PROMPT_BUDGET = 100_000;
const TRIVIAL_LINES = 10;
const SMALL_LINES = 300;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SENSITIVE_PATH =
  /(?:^|\/)(?:auth\w*|crypto\w*|secrets?|keys?|credentials?|tokens?|oauth|jwt|passwords?|permissions?|sandbox)(?:\/|\.|$)|(?:^|\/)\.env(?:\.|$)|(?:^|\/)\.github\/workflows\//i;

export interface SpecialistDef {
  name: string;
  description: string;
  // What to look for; repository specialists add their own instructions.
  focus: string;
  // Built-in scope by file category, or repository scope by path pattern.
  categories?: Category[];
  paths?: string[];
  budgetMs: number;
  model?: string;
  variant?: string;
  source: "builtin" | "repo";
}

const CODE: Category[] = ["code", "build", "config"];

export const BUILTIN_SPECIALISTS: SpecialistDef[] = [
  {
    name: "correctness",
    description: "Logic and behaviour defects",
    focus:
      "Logic errors, wrong conditions and off-by-one bugs, unhandled errors and edge cases, broken invariants, resource leaks, lifetime and ownership mistakes, races, and behaviour that contradicts the change's intent.",
    categories: CODE,
    budgetMs: DEEP_BUDGET_MS,
    source: "builtin",
  },
  {
    name: "security",
    description: "Vulnerabilities and unsafe defaults",
    focus:
      "Injection, missing authentication or authorization checks, capability or sandbox escapes, unsafe deserialization, secrets in code or logs, weak cryptography, missing input validation at trust boundaries, and unsafe defaults.",
    categories: CODE,
    budgetMs: DEEP_BUDGET_MS,
    source: "builtin",
  },
  {
    name: "performance",
    description: "Performance regressions",
    focus:
      "Work added to hot paths, needless copies and allocations, quadratic loops, blocking calls in async code, unbounded growth, and missing caching where the change makes it matter.",
    categories: CODE,
    budgetMs: DEFAULT_BUDGET_MS,
    source: "builtin",
  },
  {
    name: "api-compat",
    description: "Public API and compatibility",
    focus:
      "Breaking changes to public APIs, wire or storage formats, configuration, and command-line behaviour; behaviour changes existing users would notice without an opt-in; and API design problems in new surface.",
    categories: CODE,
    budgetMs: DEFAULT_BUDGET_MS,
    source: "builtin",
  },
  {
    name: "tests",
    description: "Test coverage and test quality",
    focus:
      "Changed behaviour without tests, tests that do not exercise what they claim, missing edge and failure cases, flaky patterns (timing, ordering, shared state), and assertions that cannot fail.",
    categories: ["code", "tests"],
    budgetMs: DEFAULT_BUDGET_MS,
    source: "builtin",
  },
  {
    name: "docs",
    description: "Documentation accuracy",
    focus:
      "Documentation and comments that are wrong, stale, or contradict the code; missing documentation for new user-facing behaviour; and broken examples.",
    categories: ["docs", "code"],
    budgetMs: DEFAULT_BUDGET_MS,
    source: "builtin",
  },
];

// Minimal frontmatter reader for specialist files: `key: value` lines and
// `- item` lists under a key. Anything else is ignored.
export function parseFrontmatter(text: string): {
  data: Record<string, string | string[]>;
  body: string;
} {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: text };
  const data: Record<string, string | string[]> = {};
  let listKey = "";
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      (data[listKey] as string[]).push(unquote(item[1]));
      continue;
    }
    const pair = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!pair) continue;
    listKey = "";
    if (pair[2] === "") {
      listKey = pair[1];
      data[listKey] = [];
    } else if (pair[2].startsWith("[") && pair[2].endsWith("]")) {
      data[pair[1]] = pair[2].slice(1, -1).split(",").map(unquote).filter(Boolean);
    } else {
      data[pair[1]] = unquote(pair[2]);
    }
  }
  return { data, body: match[2].trim() };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

export function parseDuration(value: string | undefined): number | null {
  const match = value?.trim().match(/^(\d+)(s|m|h)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? "m";
  return amount * (unit === "s" ? 1000 : unit === "h" ? 60 * MINUTE : MINUTE);
}

// Parses one `.github/bonk/specialists/*.md` file. The body is the
// specialist's instructions; `paths` scopes it to matching files.
export function parseSpecialistFile(text: string, fileName: string): SpecialistDef | string {
  const { data, body } = parseFrontmatter(text);
  const name = typeof data.name === "string" ? data.name : fileName.replace(/\.md$/, "");
  if (!NAME_PATTERN.test(name)) return `${fileName}: name must match ${NAME_PATTERN}`;
  const description = typeof data.description === "string" ? data.description : "";
  if (!description) return `${fileName}: description is required`;
  if (!body) return `${fileName}: the file needs instructions after the frontmatter`;
  const rawPaths = Array.isArray(data.paths)
    ? data.paths
    : typeof data.paths === "string"
      ? [data.paths]
      : [];
  const paths = rawPaths.filter((pattern) => compileGlob(pattern));
  if (rawPaths.length !== paths.length) return `${fileName}: invalid pattern in paths`;
  const budgetMs = parseDuration(typeof data.budget === "string" ? data.budget : undefined);
  return {
    name,
    description,
    focus: body,
    ...(paths.length > 0 ? { paths } : { categories: CODE }),
    budgetMs: budgetMs ?? DEFAULT_BUDGET_MS,
    ...(typeof data.model === "string" ? { model: data.model } : {}),
    ...(typeof data.variant === "string" ? { variant: data.variant } : {}),
    source: "repo",
  };
}

// Specialist definitions come from the pull request's base commit, so a pull
// request cannot rewrite the instructions its own review runs with.
export async function fetchRepoSpecialists(
  token: string,
  repository: string,
  ref: string,
  dir: string,
): Promise<void> {
  const listing = await fetchWithRetry(
    `https://api.github.com/repos/${repository}/contents/.github/bonk/specialists?ref=${ref}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
  );
  if (listing.status === 404) return;
  if (!listing.ok) throw new Error(`Listing specialists returned ${listing.status}`);
  const entries = (await listing.json()) as Array<{ name: string; type: string; path: string }>;
  mkdirSync(dir, { recursive: true });
  for (const entry of entries.filter((item) => item.type === "file" && item.name.endsWith(".md"))) {
    const resp = await fetchWithRetry(
      `https://api.github.com/repos/${repository}/contents/${entry.path}?ref=${ref}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw" } },
    );
    if (resp.ok) writeFileSync(join(dir, entry.name), await resp.text());
  }
}

export function loadRepoSpecialists(dir: string): { defs: SpecialistDef[]; warnings: string[] } {
  const defs: SpecialistDef[] = [];
  const warnings: string[] = [];
  if (!dir || !existsSync(dir)) return { defs, warnings };
  for (const name of readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()) {
    const parsed = parseSpecialistFile(readFileSync(join(dir, name), "utf8"), name);
    if (typeof parsed === "string") warnings.push(`Skipping specialist ${parsed}`);
    else defs.push(parsed);
  }
  return { defs, warnings };
}

export type Tier = "trivial" | "small" | "full";

export function reviewedFiles(manifest: DiffManifest): DiffFile[] {
  return manifest.files.filter((file) => !file.filtered);
}

export function sizeTier(manifest: DiffManifest): Tier {
  const lines = reviewedFiles(manifest).reduce(
    (sum, file) => sum + file.additions + file.deletions,
    0,
  );
  if (lines <= TRIVIAL_LINES) return "trivial";
  return lines <= SMALL_LINES ? "small" : "full";
}

export function scopedFiles(def: SpecialistDef, manifest: DiffManifest): DiffFile[] {
  const patterns = (def.paths ?? []).map((pattern) => compileGlob(pattern)!);
  return reviewedFiles(manifest).filter((file) =>
    patterns.length > 0
      ? patterns.some((pattern) => pattern.test(file.path))
      : (def.categories ?? CODE).includes(file.category),
  );
}

// Correctness and security can be affected by a change anywhere, so they
// are never carried forward.
export const NEVER_SKIP = new Set(["correctness", "security"]);
// Statuses that mean a specialist's last review of its files is still good.
const CARRIED_STATUSES = new Set(["ok", "issues"]);

export interface SkippedSpecialist {
  name: string;
  // The status carried forward from the last review.
  status: string;
}

export interface Selection {
  tier: Tier;
  selected: SpecialistDef[];
  skipped: SkippedSpecialist[];
}

export interface SelectionOptions {
  // "auto", "off", or a comma-separated list of specialist names.
  request: string;
  // Files the author changed since the last review; null when unknown or
  // this is a first review.
  changedFiles?: string[] | null;
  // Specialist statuses recorded with the last review.
  previous?: Record<string, string> | null;
}

export function selectSpecialists(
  defs: SpecialistDef[],
  manifest: DiffManifest,
  options: SelectionOptions,
): Selection {
  const tier = sizeTier(manifest);
  const request = options.request.trim().toLowerCase() || "auto";
  const empty = { tier, selected: [], skipped: [] };
  if (request === "off") return empty;

  const byName = new Map(defs.map((def) => [def.name, def]));
  const inScope = (def: SpecialistDef) => scopedFiles(def, manifest).length > 0;
  let wanted: SpecialistDef[];
  if (request !== "auto") {
    wanted = request
      .split(",")
      .map((name) => byName.get(name.trim()))
      .filter((def): def is SpecialistDef => Boolean(def));
  } else {
    const files = reviewedFiles(manifest);
    const has = (category: Category) => files.some((file) => file.category === category);
    const sensitive = files.some((file) => SENSITIVE_PATH.test(file.path));
    const names = new Set<string>();
    // Trivial changes get no specialists: the main run reviews them alone.
    if (tier !== "trivial") names.add("correctness");
    if (tier === "full" || sensitive) names.add("security");
    if (tier === "full" && has("code")) {
      names.add("performance");
      names.add("api-compat");
    }
    if (tier !== "trivial" && has("tests")) names.add("tests");
    if (tier === "full" && has("code")) names.add("tests");
    if (tier !== "trivial" && has("docs")) names.add("docs");
    if (tier !== "trivial") {
      for (const def of defs) if (def.source === "repo") names.add(def.name);
    }
    wanted = [...names]
      .map((name) => byName.get(name))
      .filter((def): def is SpecialistDef => Boolean(def));
  }
  // Re-review: a specialist whose files the author has not touched since its
  // last successful run keeps that result. Any doubt means it runs.
  const selected: SpecialistDef[] = [];
  const skipped: SkippedSpecialist[] = [];
  for (const def of wanted.filter(inScope)) {
    const previous = options.previous?.[def.name];
    const changed = options.changedFiles;
    const untouched =
      Array.isArray(changed) &&
      !scopedFiles(def, manifest).some((file) => changed.includes(file.path));
    if (!NEVER_SKIP.has(def.name) && previous && CARRIED_STATUSES.has(previous) && untouched) {
      skipped.push({ name: def.name, status: previous });
    } else {
      selected.push(def);
    }
  }
  return { tier, selected, skipped };
}

// OpenCode config for one specialist: the consumer's config (providers and
// so on) with a read-only agent added and memory-hungry features off.
export function buildSpecialistConfig(
  consumerConfig: string | undefined,
  def: SpecialistDef,
  runnerTemp: string,
): string {
  let config: Record<string, unknown> = {};
  if (consumerConfig?.trim()) {
    const bunRuntime = (globalThis as { Bun?: { JSONC?: { parse(value: string): unknown } } }).Bun;
    const parsed = bunRuntime?.JSONC
      ? bunRuntime.JSONC.parse(consumerConfig)
      : JSON.parse(consumerConfig);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      config = { ...(parsed as Record<string, unknown>) };
    }
  }
  const permission = {
    edit: "deny",
    webfetch: "deny",
    websearch: "deny",
    task: "deny",
    question: "deny",
    doom_loop: "deny",
    external_directory: { "*": "deny", [`${runnerTemp}/**`]: "allow" },
    bash: {
      "*": "allow",
      "gh *": "deny",
      "git push*": "deny",
      "git commit*": "deny",
      "git checkout*": "deny",
      "git reset*": "deny",
      "git worktree*": "deny",
      "curl *": "deny",
      "wget *": "deny",
      "rm *": "deny",
    },
  };
  const agents = (config.agent as Record<string, unknown> | undefined) ?? {};
  return JSON.stringify({
    ...config,
    lsp: false,
    snapshot: false,
    share: "disabled",
    permission,
    agent: {
      ...agents,
      [`bonk-${def.name}`]: {
        description: def.description,
        mode: "primary",
        permission,
        prompt:
          "You are a specialist code reviewer. You only read code and write your findings file; you never change the repository or talk to GitHub.",
      },
    },
  });
}

export interface SpecialistContext {
  repository: string;
  prNumber: string;
  outFile: string;
  budgetMs: number;
}

export function buildSpecialistPrompt(
  def: SpecialistDef,
  manifest: DiffManifest,
  context: SpecialistContext,
): string {
  const files = scopedFiles(def, manifest);
  const patches = files.map((file) => ({ file, patch: readPatch(file) }));
  const bytes = patches.reduce((sum, entry) => sum + Buffer.byteLength(entry.patch), 0);
  const inline = bytes <= SPECIALIST_PROMPT_BUDGET;
  const minutes = Math.max(1, Math.round(context.budgetMs / MINUTE));
  const lines = [
    `You are the ${def.name} specialist reviewing pull request #${context.prNumber} in ${context.repository}. The working directory is the pull request's head.`,
    "",
    `Your area: ${def.description}.`,
    def.source === "repo" ? "Instructions for this area:" : "Look for:",
    def.focus,
    "",
    "Rules:",
    "- Review only the files listed below, and only problems the pull request introduces in your area. Never raise problems in code the pull request does not change.",
    "- You are read-only: do not edit files, run git commands that change state, or use gh or the GitHub API.",
    "- Report only concrete, verifiable problems; skip style preferences and speculation.",
    "- severity: blocking (must fix before merging), warning (real defect, should fix), info (worth knowing), suggestion (optional improvement), or question (you need an answer; at most one).",
    '- Set "justified": true when the code carries an explicit comment justifying what you flag.',
    '- Cite a rule only as "quote": {"path": "<file>", "text": "<exact text>"} copied verbatim from a file you read.',
    "",
    `Write your findings to ${context.outFile} as JSON with a quoted shell heredoc (cat > "<file>" <<'EOF'), replacing its content:`,
    '{"findings": [{"path": "src/file.ts", "line": 42, "side": "RIGHT", "severity": "warning", "body": "What is wrong and how to fix it."}]}',
    '`line` is a line in the patch below (`side` RIGHT for added or unchanged lines, LEFT for deleted ones); add `start_line` for a range. Write {"findings": []} when you find nothing.',
    `You have about ${minutes} minutes. Write the file as soon as you have a first finding and update it as you go: when time runs out, whatever the file holds is used. Your final text reply is ignored.`,
    "",
    "<bonk_diff>",
  ];
  for (const { file } of patches) {
    lines.push(
      `- ${file.status} ${escapePromptValue(file.path)} +${file.additions}/-${file.deletions}${!inline && file.patchFile ? ` patch: ${file.patchFile}` : ""}`,
    );
  }
  if (inline) {
    for (const { file, patch } of patches) {
      if (!patch) continue;
      lines.push(`=== ${escapePromptValue(file.path)} ===`, neutralizeTags(patch.trimEnd()));
    }
  } else {
    lines.push("The patches are too large to include; read each from its path.");
  }
  lines.push("</bonk_diff>");
  return lines.join("\n");
}

// Tracks a specialist's `--format json` event stream. Any output is activity;
// step_start/step_finish tell whether the model is inside a step, where
// silence is normal for a while (reasoning before the first token, or a long
// tool call).
export class Watchdog {
  private lastActivity: number;
  private inStep = false;

  constructor(
    now: number,
    private readonly stallMs = STALL_MS,
  ) {
    this.lastActivity = now;
  }

  observe(line: string, now: number): void {
    this.lastActivity = now;
    try {
      const event = JSON.parse(line) as { type?: string };
      if (event.type === "step_start") this.inStep = true;
      if (event.type === "step_finish") this.inStep = false;
    } catch {
      // Not an event line; still activity.
    }
  }

  stalled(now: number): boolean {
    const idle = now - this.lastActivity;
    return idle > (this.inStep ? this.stallMs * 2 : this.stallMs);
  }
}

export type SpecialistStatus =
  | "ok"
  | "issues"
  | "partial"
  | "timed_out"
  | "stalled"
  | "failed"
  | "not_run";

export interface SpecialistResult {
  name: string;
  status: SpecialistStatus;
  reason?: string;
  findings: Finding[];
  attempts: number;
}

function describeStatus(result: SpecialistResult): string {
  switch (result.status) {
    case "ok":
      return "no findings";
    case "issues":
      return `${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}`;
    case "partial":
      return `ran out of time; ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"} written before that`;
    default:
      return result.reason ?? result.status;
  }
}

export function notReviewed(result: SpecialistResult): boolean {
  return !["ok", "issues", "partial"].includes(result.status);
}

// The block the judge (the main run) receives. Findings are model output and
// escaped like any other untrusted text.
export function formatSpecialistFindings(
  results: SpecialistResult[],
  skipped: SkippedSpecialist[] = [],
): string {
  const lines = [
    "<bonk_specialist_findings>",
    "Specialist reviewers looked at parts of this pull request. Their findings are unverified claims.",
  ];
  for (const result of results) {
    lines.push(`specialist: ${result.name} (${escapePromptValue(describeStatus(result))})`);
    if (notReviewed(result))
      lines.push(
        `  ${result.name}: not reviewed (${escapePromptValue(result.reason ?? result.status)})`,
      );
    for (const finding of result.findings) {
      const location = finding.path
        ? `${finding.path}${finding.line ? `:${finding.startLine ? `${finding.startLine}-` : ""}${finding.line}` : ""} (${finding.side})`
        : "whole change";
      const quote = finding.quote
        ? ` [quote from ${finding.quote.path}: "${finding.quote.text}"]`
        : "";
      const justified = finding.justified ? " [justified in code]" : "";
      lines.push(
        `- [${finding.severity}] ${escapePromptValue(location)}: ${escapePromptValue(finding.body.trim()).replace(/\n/g, "\n    ")}${escapePromptValue(quote)}${justified}`,
      );
    }
  }
  for (const skip of skipped) {
    lines.push(
      `specialist: ${skip.name} (not re-run: the author did not change its files since the last review; its earlier findings stand)`,
    );
  }
  lines.push("</bonk_specialist_findings>");
  return lines.join("\n");
}

function killTree(proc: BunSubprocess): void {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      proc.kill(signal);
    }
  }
}

async function readLines(
  stream: ReadableStream<Uint8Array> | null,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) onLine(part);
    }
  } catch {
    // The process was killed.
  }
  if (buffer) onLine(buffer);
}

interface AttemptOptions {
  def: SpecialistDef;
  cwd: string;
  promptFile: string;
  outFile: string;
  config: string;
  deadlineMs: number;
  model?: string;
  variant?: string;
}

async function runAttempt(
  options: AttemptOptions,
): Promise<Omit<SpecialistResult, "name" | "attempts">> {
  const args = [
    "opencode",
    "run",
    "Review the attached assignment and write your findings file.",
    "--agent",
    `bonk-${options.def.name}`,
    "--format",
    "json",
  ];
  const model = options.def.model ?? options.model;
  const variant = options.def.variant ?? options.variant;
  if (model) args.push("--model", model);
  if (variant) args.push("--variant", variant);
  args.push("--file", options.promptFile);

  // No GitHub or OIDC credentials: specialists only read.
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_CONFIG_CONTENT: options.config };
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
  ]) {
    delete env[key];
  }

  let proc: BunSubprocess;
  try {
    proc = Bun.spawn(args, {
      detached: true,
      cwd: options.cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return { status: "failed", reason: `could not start OpenCode: ${error}`, findings: [] };
  }

  const started = Date.now();
  const watchdog = new Watchdog(started);
  let ended: "deadline" | "stall" | null = null;
  const onLine = (line: string) => watchdog.observe(line, Date.now());
  const streams = Promise.all([readLines(proc.stdout, onLine), readLines(proc.stderr, onLine)]);
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - started >= options.deadlineMs) ended = "deadline";
    else if (watchdog.stalled(now)) ended = "stall";
    if (ended) killTree(proc);
  }, 5000);
  const exitCode = await proc.exited;
  clearInterval(timer);
  await Promise.race([streams, new Promise((resolve) => setTimeout(resolve, 1000))]);

  const file = existsSync(options.outFile)
    ? parseReviewFile(readFileSync(options.outFile, "utf8"))
    : null;
  const limit =
    options.deadlineMs >= MINUTE
      ? `${Math.round(options.deadlineMs / MINUTE)} min`
      : `${Math.round(options.deadlineMs / 1000)} s`;
  if (ended === "deadline") {
    return file
      ? { status: "partial", findings: file.findings }
      : { status: "timed_out", reason: `timed out after ${limit}`, findings: [] };
  }
  if (ended === "stall")
    return { status: "stalled", reason: "stopped producing output", findings: [] };
  if (!file) {
    return {
      status: "failed",
      reason: exitCode === 0 ? "finished without writing findings" : `exited with code ${exitCode}`,
      findings: [],
    };
  }
  return { status: file.findings.length > 0 ? "issues" : "ok", findings: file.findings };
}

async function runSpecialist(
  def: SpecialistDef,
  shared: {
    manifest: DiffManifest;
    dir: string;
    cwd: string;
    consumerConfig: string | undefined;
    runnerTemp: string;
    stepDeadline: number;
    repository: string;
    prNumber: string;
    model?: string;
    variant?: string;
  },
): Promise<SpecialistResult> {
  const outFile = join(shared.dir, `${def.name}.findings.json`);
  const promptFile = join(shared.dir, `${def.name}.prompt.md`);
  const config = buildSpecialistConfig(shared.consumerConfig, def, shared.runnerTemp);
  let last: Omit<SpecialistResult, "name" | "attempts"> = {
    status: "not_run",
    reason: "out of time before it could start",
    findings: [],
  };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remaining = shared.stepDeadline - Date.now();
    if (remaining < MINUTE) return { name: def.name, attempts: attempt - 1, ...last };
    const deadlineMs = Math.min(def.budgetMs, remaining);
    writeFileSync(
      promptFile,
      buildSpecialistPrompt(def, shared.manifest, {
        repository: shared.repository,
        prNumber: shared.prNumber,
        outFile,
        budgetMs: deadlineMs,
      }),
    );
    core.info(
      `Specialist ${def.name}: attempt ${attempt}, budget ${Math.round(deadlineMs / 1000)}s`,
    );
    last = await runAttempt({
      def,
      cwd: shared.cwd,
      promptFile,
      outFile,
      config,
      deadlineMs,
      model: shared.model,
      variant: shared.variant,
    });
    core.info(`Specialist ${def.name}: ${last.status}${last.reason ? ` (${last.reason})` : ""}`);
    // Only crashes and stalls are worth a second launch; a timeout would
    // just time out again.
    if (last.status !== "failed" && last.status !== "stalled") {
      return { name: def.name, attempts: attempt, ...last };
    }
  }
  return { name: def.name, attempts: MAX_ATTEMPTS, ...last };
}

async function runPool<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// A worktree at the pull request head: the main checkout may be a merge
// commit or the default branch, and `opencode github run` switches it later.
async function prepareHeadWorktree(dir: string, head: string): Promise<string> {
  const run = async (args: string[]) => {
    const proc = Bun.spawn(["git", ...args], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  };
  if (await run(["worktree", "add", "--detach", dir, head])) return dir;
  if (
    (await run(["fetch", "--depth=1", "origin", head])) &&
    (await run(["worktree", "add", "--detach", dir, head]))
  ) {
    return dir;
  }
  core.warning(
    "Could not check out the pull request head for specialists; they will rely on the patches.",
  );
  return process.cwd();
}

export interface SpecialistStatusRecord {
  status: string;
  reason?: string;
}

export async function runSpecialists(): Promise<void> {
  const state = parsePublishState(process.env.REVIEW_STATE);
  const runnerTemp = process.env.RUNNER_TEMP || "";
  const manifest = readManifest(state?.diffDir);
  if (!state || !manifest || !runnerTemp || !state.expectReview) {
    core.info("No review to run specialists for.");
    return;
  }

  const { defs: repoDefs, warnings } = loadRepoSpecialists(state.specialistsDir);
  for (const warning of warnings) core.warning(warning);
  const defs = new Map(BUILTIN_SPECIALISTS.map((def) => [def.name, def]));
  // A repository specialist with a built-in's name replaces it.
  for (const def of repoDefs) defs.set(def.name, def);

  const selection = selectSpecialists([...defs.values()], manifest, {
    request: process.env.SPECIALISTS || "auto",
    changedFiles: state.rereview ? state.changedFiles : null,
    previous: state.previousSpecialists,
  });
  core.info(
    `Review tier ${selection.tier}; specialists: ${selection.selected.map((def) => def.name).join(", ") || "none"}${selection.skipped.length > 0 ? `; carried forward: ${selection.skipped.map((skip) => skip.name).join(", ")}` : ""}`,
  );
  if (selection.selected.length === 0 && selection.skipped.length === 0) return;

  const dir = join(runnerTemp, `bonk-specialists-${process.env.GITHUB_RUN_ID || "local"}`);
  mkdirSync(dir, { recursive: true });
  const cwd =
    selection.selected.length > 0
      ? await prepareHeadWorktree(join(dir, "head"), state.head)
      : process.cwd();
  const stepTimeout = parseDuration(process.env.SPECIALIST_TIMEOUT) ?? DEFAULT_STEP_TIMEOUT_MS;
  const parallelism = Math.max(
    1,
    Number.parseInt(process.env.SPECIALIST_PARALLELISM || "", 10) || DEFAULT_PARALLELISM,
  );
  const stepDeadline = Date.now() + stepTimeout;
  const results = await runPool(selection.selected, parallelism, (def) =>
    runSpecialist(def, {
      manifest,
      dir,
      cwd,
      consumerConfig: process.env.OPENCODE_CONFIG_CONTENT,
      runnerTemp,
      stepDeadline,
      repository: process.env.GITHUB_REPOSITORY || "",
      prNumber: process.env.PR_NUMBER || "",
      model: process.env.SPECIALIST_MODEL || process.env.MODEL || undefined,
      variant: process.env.SPECIALIST_VARIANT || process.env.VARIANT || undefined,
    }),
  );

  const statuses: Record<string, SpecialistStatusRecord> = {};
  for (const result of results) {
    statuses[result.name] = {
      status: result.status,
      ...(notReviewed(result) && result.reason ? { reason: result.reason } : {}),
    };
  }
  for (const skip of selection.skipped) {
    statuses[skip.name] = { status: skip.status, reason: CARRIED_FORWARD };
  }

  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  appendGitHubValue(
    outputFile,
    "prompt",
    `${process.env.PROMPT ?? ""}\n\n${formatSpecialistFindings(results, selection.skipped)}`,
  );
  appendGitHubValue(outputFile, "statuses", JSON.stringify(statuses));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSpecialists().catch((error) => {
    // Specialists only add evidence; the main review still runs without them.
    core.warning(`Specialists failed: ${error}`);
  });
}
