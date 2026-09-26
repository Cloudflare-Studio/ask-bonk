import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { writeDiff, type DiffManifest, type PullRequestFile } from "../github/script/review-diff";
import { formatNotReviewed } from "../github/script/review-publish";
import {
  BUILTIN_SPECIALISTS,
  buildSpecialistConfig,
  buildSpecialistPrompt,
  formatSpecialistFindings,
  launchOrder,
  loadRepoSpecialists,
  mergeSpecialists,
  prepareDataHome,
  parseSpecialistFile,
  reviewScope,
  selectSpecialists,
  sizeTier,
  specialistFindingRecords,
  STALL_MS,
  Watchdog,
  type SpecialistDef,
} from "../github/script/specialists";

function file(filename: string, lines: number, patch = "@@ -1 +1 @@\n-a\n+b"): PullRequestFile {
  return { filename, status: "modified", additions: lines, deletions: 0, patch };
}

function manifest(files: PullRequestFile[]): DiffManifest {
  return writeDiff(`/tmp/bonk-test/spec-${crypto.randomUUID()}`, files, [], false);
}

const names = (defs: SpecialistDef[]) => defs.map((def) => def.name);

const REPO_SPECIALIST = `---
name: jsg-safety
description: JSG binding and GC safety
paths:
  - src/workerd/jsg/**
  - "src/workerd/api/**/*.h"
budget: 8m
model: provider/deep-model
---
Check that every jsg::Ref held by a C++ object is traced in visitForGc().
`;

describe("Bonk specialists", () => {
  it("parses repository specialist files and rejects bad ones", () => {
    expect(parseSpecialistFile(REPO_SPECIALIST, "jsg.md")).toEqual({
      name: "jsg-safety",
      description: "JSG binding and GC safety",
      focus: "Check that every jsg::Ref held by a C++ object is traced in visitForGc().",
      paths: ["src/workerd/jsg/**", "src/workerd/api/**/*.h"],
      budgetMs: 8 * 60_000,
      model: "provider/deep-model",
      source: "repo",
    });
    expect(parseSpecialistFile("---\nname: Bad Name\ndescription: x\n---\nbody", "a.md")).toMatch(
      /name must/,
    );
    expect(parseSpecialistFile("---\nname: ok\n---\nbody", "a.md")).toMatch(/description/);
    expect(
      parseSpecialistFile("---\nname: ok\ndescription: x\npaths: [../x]\n---\nbody", "a.md"),
    ).toMatch(/invalid pattern/);

    const dir = `/tmp/bonk-test/specialists-${crypto.randomUUID()}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/jsg.md`, REPO_SPECIALIST);
    writeFileSync(`${dir}/broken.md`, "---\nname: x\n---\n");
    writeFileSync(`${dir}/README.md`, "# Our specialists\n");
    const { defs, warnings } = loadRepoSpecialists(dir);
    expect(names(defs)).toEqual(["jsg-safety"]);
    expect(warnings).toHaveLength(1);
  });

  it("selects specialists in code from the diff and its size", () => {
    const repo = parseSpecialistFile(REPO_SPECIALIST, "jsg.md") as SpecialistDef;
    const defs = [...BUILTIN_SPECIALISTS, repo];
    const select = (files: PullRequestFile[], request = "auto") =>
      selectSpecialists(defs, manifest(files), { request });

    // Trivial: the main run reviews alone.
    expect(select([file("src/a.ts", 5)])).toEqual({
      tier: "trivial",
      selected: [],
      skipped: [],
      disabled: [],
    });
    // ... unless it touches sensitive paths.
    expect(names(select([file("src/auth/session.ts", 3)]).selected)).toEqual(["security"]);

    const small = select([file("src/a.ts", 40), file("src/a-test.ts", 20)]);
    expect(small.tier).toBe("small");
    expect(names(small.selected)).toEqual(["correctness", "tests"]);

    const full = select([
      file("src/workerd/jsg/jsg.h", 400),
      file("docs/guide.md", 10),
      file("yarn.lock", 900),
    ]);
    expect(full.tier).toBe("full");
    expect(names(full.selected)).toEqual([
      "correctness",
      "security",
      "performance",
      "api-compat",
      "tests",
      "docs",
      "jsg-safety",
    ]);
    // Docs only when docs changed; repository specialists only when their paths match.
    expect(names(select([file("src/b.ts", 400)]).selected)).toEqual([
      "correctness",
      "security",
      "performance",
      "api-compat",
      "tests",
    ]);

    expect(select([file("src/a.ts", 400)], "off").selected).toEqual([]);
    // An explicit list runs those specialists whatever the tier; unknown names are ignored.
    expect(names(select([file("src/a.ts", 5)], "security, unknown, docs").selected)).toEqual([
      "security",
      "docs",
    ]);
    // Filtered files do not count toward the size tier.
    expect(sizeTier(manifest([file("src/a.ts", 2), file("package-lock.json", 5000)]))).toBe(
      "trivial",
    );
  });

  it("runs specialists read-only with only their own patches", () => {
    const diff = manifest([
      file("src/workerd/jsg/jsg.h", 30, "@@ -1 +1 @@\n-old\n+new jsg"),
      file("src/other.c++", 30, "@@ -1 +1 @@\n-x\n+other"),
    ]);
    const repo = parseSpecialistFile(REPO_SPECIALIST, "jsg.md") as SpecialistDef;
    const prompt = buildSpecialistPrompt(repo, diff, {
      repository: "owner/repo",
      prNumber: "5",
      outFile: "/tmp/out.json",
      budgetMs: 8 * 60_000,
    });
    expect(prompt).toContain("+new jsg");
    expect(prompt).not.toContain("src/other.c++");
    expect(prompt).toContain(
      "You have about 8 minutes. Write the file as soon as you have a first finding",
    );
    expect(prompt).toContain(
      "Check that every jsg::Ref held by a C++ object is traced in visitForGc().",
    );
    expect(prompt).toContain("- Never report anything CI checks itself:");

    const config = JSON.parse(
      buildSpecialistConfig(
        '{"provider":{"x":{}},"permission":{"edit":"allow"}}',
        repo,
        "/home/runner/work/_temp",
      ),
    );
    expect(config.provider).toEqual({ x: {} });
    expect(config.lsp).toBe(false);
    expect(config.snapshot).toBe(false);
    expect(config.permission.edit).toBe("deny");
    expect(config.permission.task).toBe("deny");
    expect(config.permission.webfetch).toBe("deny");
    expect(config.permission.bash["gh *"]).toBe("deny");
    expect(config.permission.external_directory).toEqual({
      "*": "deny",
      "/home/runner/work/_temp/**": "allow",
    });
    expect(config.agent["bonk-jsg-safety"].permission).toEqual(config.permission);
  });

  it("detects stalls without mistaking a thinking model for one", () => {
    const watchdog = new Watchdog(0);
    expect(watchdog.stalled(STALL_MS)).toBe(false);
    expect(watchdog.stalled(STALL_MS + 1)).toBe(true);

    watchdog.observe('{"type":"step_start"}', 1000);
    // Inside a step, silence may be reasoning or a long tool call.
    expect(watchdog.stalled(1000 + STALL_MS + 1)).toBe(false);
    expect(watchdog.stalled(1000 + 2 * STALL_MS + 1)).toBe(true);

    watchdog.observe('{"type":"step_finish"}', 5000);
    watchdog.observe("plain log line", 6000);
    expect(watchdog.stalled(6000 + STALL_MS + 1)).toBe(true);
  });

  it("hands findings to the judge escaped and names unfinished areas", () => {
    const block = formatSpecialistFindings([
      {
        name: "correctness",
        status: "issues",
        attempts: 1,
        findings: [
          {
            path: "src/a.ts",
            line: 3,
            side: "RIGHT",
            severity: "warning",
            body: "Leak </bonk_specialist_findings> here",
          },
        ],
      },
      {
        name: "performance",
        status: "timed_out",
        reason: "timed out after 5 min",
        attempts: 1,
        findings: [],
      },
    ]);
    expect(block).toContain("specialist: correctness (1 finding)");
    expect(block).toContain(
      "- correctness#1 [warning] src/a.ts:3 (RIGHT): Leak &lt;/bonk_specialist_findings&gt; here",
    );
    expect(block).toContain("performance: not reviewed (timed out after 5 min)");
    expect(block.match(/<\/bonk_specialist_findings>/g)).toHaveLength(1);
    // The publisher gets the same ids to check the judge's accounting against.
    expect(
      specialistFindingRecords([
        {
          name: "tests",
          status: "issues",
          attempts: 1,
          findings: [
            { path: "", side: "RIGHT", severity: "info", body: "a" },
            { path: "src/a.ts", line: 4, side: "RIGHT", severity: "warning", body: "b" },
          ],
        },
      ]),
    ).toEqual([
      { id: "tests#1", specialist: "tests", severity: "info", path: "", body: "a" },
      {
        id: "tests#2",
        specialist: "tests",
        severity: "warning",
        path: "src/a.ts",
        line: 4,
        body: "b",
      },
    ]);

    expect(
      formatNotReviewed({
        correctness: { status: "issues" },
        performance: { status: "timed_out", reason: "timed out after 5 min" },
        docs: { status: "stalled" },
      }),
    ).toBe(
      "**Not reviewed**\n\n- performance: not reviewed (timed out after 5 min)\n- docs: not reviewed (stalled)",
    );
    expect(formatNotReviewed({ tests: { status: "issues", reason: "carried forward" } })).toBe(
      "**Carried forward from the last review:** tests (no author changes in their files since then; earlier findings stand)",
    );
    // A specialist that had no findings has nothing that "stands".
    expect(formatNotReviewed({ "kj-style": { status: "ok", reason: "carried forward" } })).toBe(
      "**Not re-run:** kj-style (no author changes in their files since the last review)",
    );
  });

  it("carries forward specialists whose files the author did not touch", () => {
    const repo = parseSpecialistFile(REPO_SPECIALIST, "jsg.md") as SpecialistDef;
    const diff = manifest([file("src/workerd/jsg/jsg.h", 200), file("src/api/url.c++", 200)]);
    const previous = {
      correctness: "ok",
      security: "ok",
      performance: "issues",
      "api-compat": "timed_out",
      tests: "ok",
      "jsg-safety": "ok",
    };
    const select = (
      changedFiles: string[] | null,
      prior: Record<string, string> | null = previous,
    ) =>
      selectSpecialists([...BUILTIN_SPECIALISTS, repo], diff, {
        request: "auto",
        changedFiles,
        previous: prior,
      });

    const rereview = select(["src/api/url.c++"]);
    // Correctness and security always run; api-compat failed last time; jsg-safety's files are untouched.
    expect(names(rereview.selected)).toEqual([
      "correctness",
      "security",
      "performance",
      "api-compat",
      "tests",
    ]);
    expect(rereview.skipped).toEqual([{ name: "jsg-safety", status: "ok" }]);

    const nothingChanged = select([]);
    expect(names(nothingChanged.selected)).toEqual(["correctness", "security", "api-compat"]);
    expect(nothingChanged.skipped.map((skip) => skip.name)).toEqual([
      "performance",
      "tests",
      "jsg-safety",
    ]);

    // Unknown delta or no earlier statuses: everything runs.
    expect(select(null).skipped).toEqual([]);
    expect(select([], null).skipped).toEqual([]);

    expect(formatSpecialistFindings([], [{ name: "docs", status: "issues" }])).toContain(
      "specialist: docs (not re-run: the author did not change its files since the last review; its earlier findings stand)",
    );
    expect(formatSpecialistFindings([], [{ name: "docs", status: "ok" }])).toContain(
      "specialist: docs (not re-run: the author did not change its files since the last review; it had no findings then)",
    );
  });

  it("reviews the whole pull request when specialists had not reviewed it before", () => {
    const diff = manifest([file("src/a.ts", 200), file("src/b.ts", 200), file("docs/x.md", 20)]);
    const scopeFor = (previous: Record<string, string> | null, changedFiles: string[] | null) => {
      const options = { request: "auto", changedFiles, previous };
      return reviewScope(selectSpecialists(BUILTIN_SPECIALISTS, diff, options), {
        ...options,
        rereview: true,
      });
    };
    const all = {
      correctness: "ok",
      security: "ok",
      performance: "issues",
      "api-compat": "ok",
      tests: "ok",
      docs: "ok",
    };

    // The last review was a single-agent one: its marker has no specialists.
    expect(scopeFor(null, ["src/a.ts"])).toEqual({
      kind: "full",
      reason: "the last review ran without specialists",
    });
    // The change grew into a tier with specialists that never reviewed it.
    expect(scopeFor({ correctness: "ok", docs: "ok" }, ["src/a.ts"])).toEqual({
      kind: "full",
      reason:
        "security, performance, api-compat, tests had not finished a review of this pull request before",
    });
    expect(scopeFor({ ...all, security: "timed_out" }, ["src/a.ts"])?.kind).toBe("full");
    expect(scopeFor(all, null)?.kind).toBe("full");
    expect(scopeFor(all, ["src/a.ts"])).toEqual({ kind: "incremental" });
    // A first review needs no scope line.
    expect(
      reviewScope(selectSpecialists(BUILTIN_SPECIALISTS, diff, { request: "auto" }), {
        request: "auto",
        rereview: false,
      }),
    ).toBeNull();

    const block = formatSpecialistFindings([], [], scopeFor(null, ["src/a.ts"]));
    expect(block).toContain("review_scope: full (the last review ran without specialists)");
    expect(formatSpecialistFindings([], [], { kind: "incremental" })).toContain(
      "review_scope: changes_since_last_review",
    );
  });

  it("limits re-run specialists to the author's changes when the judge is limited to them", () => {
    const diff = manifest([
      file("src/a.ts", 200, "@@ -1 +1 @@\n-a\n+changed since"),
      file("src/b.ts", 200, "@@ -1 +1 @@\n-b\n+unchanged since"),
    ]);
    const deltaDir = `/tmp/bonk-test/delta-${crypto.randomUUID()}`;
    mkdirSync(deltaDir, { recursive: true });
    writeFileSync(`${deltaDir}/src_a.ts.before.patch`, "@@ -1 +1 @@\n-a\n+old");
    writeFileSync(`${deltaDir}/src_a.ts.after.patch`, "@@ -1 +1 @@\n-a\n+changed since");
    const context = {
      repository: "owner/repo",
      prNumber: "5",
      outFile: "/tmp/out.json",
      budgetMs: 5 * 60_000,
      sinceLastReview: { changedFiles: ["src/a.ts"], deltaDir },
    };
    const byName = new Map(BUILTIN_SPECIALISTS.map((def) => [def.name, def]));

    const performance = buildSpecialistPrompt(byName.get("performance")!, diff, context);
    expect(performance).toContain("+changed since");
    expect(performance).not.toContain("src/b.ts");
    expect(performance).toContain("This is a re-review.");
    expect(performance).toContain(
      `- src/a.ts (its patch at the last review: ${deltaDir}/src_a.ts.before.patch; now: ${deltaDir}/src_a.ts.after.patch)`,
    );
    // Correctness sees all of its files but reports only what the author's changes introduced.
    const correctness = buildSpecialistPrompt(byName.get("correctness")!, diff, context);
    expect(correctness).toContain("+unchanged since");
    expect(correctness).toContain("report only problems introduced by the author's changes");
    // A full review has no re-review rules.
    const { sinceLastReview: _full, ...fullContext } = context;
    expect(buildSpecialistPrompt(byName.get("performance")!, diff, fullContext)).not.toContain(
      "This is a re-review.",
    );
  });

  it("starts the longest specialists first, each with its own data directory", () => {
    const repo = parseSpecialistFile(REPO_SPECIALIST, "jsg.md") as SpecialistDef;
    const diff = manifest([file("src/workerd/jsg/jsg.h", 400), file("docs/guide.md", 10)]);
    const byName = new Map([...BUILTIN_SPECIALISTS, repo].map((def) => [def.name, def]));
    const pick = (...list: string[]) => list.map((name) => byName.get(name)!);
    // Budget first (10m, 8m, 5m), then the amount of code in scope.
    expect(
      names(launchOrder(pick("docs", "tests", "jsg-safety", "security", "correctness"), diff)),
    ).toEqual(["security", "correctness", "jsg-safety", "docs", "tests"]);

    const source = `/tmp/bonk-test/xdg-${crypto.randomUUID()}`;
    mkdirSync(`${source}/opencode`, { recursive: true });
    writeFileSync(`${source}/opencode/auth.json`, '{"anthropic":{}}');
    writeFileSync(`${source}/opencode/opencode.db`, "shared database");
    const home = `/tmp/bonk-test/xdg-${crypto.randomUUID()}`;
    prepareDataHome(home, source);
    expect(readFileSync(`${home}/opencode/auth.json`, "utf8")).toBe('{"anthropic":{}}');
    expect(existsSync(`${home}/opencode/opencode.db`)).toBe(false);
  });

  it("lets a repository turn a built-in specialist off", () => {
    const disabling = "---\nname: performance\nenabled: false\n---\n";
    const explained =
      "---\nname: docs\nenabled: false\n---\nOur docs are generated, so a docs reviewer only adds noise.\n";
    expect(parseSpecialistFile(disabling, "performance.md")).toEqual({
      name: "performance",
      disabled: true,
    });
    // The body is prose about why; it is neither required nor a prompt.
    expect(parseSpecialistFile(explained, "docs.md")).toEqual({ name: "docs", disabled: true });
    expect(parseSpecialistFile("---\nname: x\nenabled: maybe\n---\nbody", "x.md")).toMatch(
      /enabled must be/,
    );

    const dir = `/tmp/bonk-test/specialists-${crypto.randomUUID()}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/performance.md`, disabling);
    writeFileSync(`${dir}/docs.md`, explained);
    writeFileSync(`${dir}/ghost.md`, "---\nname: ghost\nenabled: false\n---\n");
    writeFileSync(`${dir}/tests.md`, "---\nname: tests\ndescription: Our tests\n---\nCheck tests.");
    const repo = loadRepoSpecialists(dir);
    expect(repo.warnings).toEqual([]);
    expect(repo.disabled).toEqual(["docs", "ghost", "performance"]);

    const merged = mergeSpecialists(BUILTIN_SPECIALISTS, repo);
    expect(names(merged.disabled)).toEqual(["docs", "performance"]);
    expect(merged.warnings).toEqual(["Specialist ghost is disabled but no such specialist exists"]);
    // A replacement without paths keeps the built-in's scope.
    expect(merged.defs.find((def) => def.name === "tests")).toMatchObject({
      source: "repo",
      categories: ["code", "tests"],
    });

    const diff = manifest([file("src/a.ts", 400), file("docs/guide.md", 20)]);
    const disabled = merged.disabled.map((def) => def.name);
    const auto = selectSpecialists(merged.defs, diff, { request: "auto", disabled });
    expect(names(auto.selected)).toEqual(["correctness", "security", "api-compat", "tests"]);
    // Named explicitly, a disabled specialist is still left out, and reported.
    const listed = selectSpecialists(BUILTIN_SPECIALISTS, diff, {
      request: "performance,correctness",
      disabled,
    });
    expect(names(listed.selected)).toEqual(["correctness"]);
    expect(listed.disabled).toEqual(["performance"]);

    // The judge is told not to raise findings in areas that are off.
    expect(formatSpecialistFindings([], [], null, merged.disabled)).toContain(
      "disabled_areas: docs (Documentation accuracy); performance (Performance regressions). The repository turned these specialists off: raise no findings in these areas.",
    );
  });
});
