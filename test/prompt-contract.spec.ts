import { describe, expect, it } from "vitest";
import repositoryReviewWorkflow from "../.github/workflows/review.yml?raw";
import generatedReviewWorkflow from "../cli/templates/review.yml.hbs?raw";
import action from "../github/action.yml?raw";
import guidance from "../github/bonk_guidance.md?raw";
import resultExtension from "../github/extensions/bonk-result.ts?raw";
import runPiScript from "../github/script/run-pi.ts?raw";

const reviewPrompt = [
  "Review this pull request for discrete, actionable defects introduced by the change.",
  "Inspect the diff, relevant surrounding code, and applicable repository instructions.",
  "Ignore non-blocking style preferences and speculative concerns. Report every qualifying finding in severity order.",
].join("\n");

describe("Bonk Pi prompt contract", () => {
  it("assigns top-level delivery to the Bonk harness without claiming exactly-once enforcement", () => {
    expect(guidance).toContain("The Bonk harness owns branches, commits, pushes, pull requests");
    expect(guidance).toContain("Finish every successful run by calling `submit_result`");
    expect(guidance).toContain("Pi must never call `gh`");
    expect(guidance).not.toMatch(/exactly once/i);
    expect(guidance).toContain("If the review found no actionable issues at all");
  });

  it.each([
    ["repository workflow", repositoryReviewWorkflow],
    ["generated workflow", generatedReviewWorkflow],
  ])(
    "keeps the %s task prompt narrow and free of untrusted PR interpolation",
    (_name, workflow) => {
      expect(workflow).toContain(reviewPrompt.replaceAll("\n", "\n            "));
      expect(workflow).not.toContain("Get PR details");
      expect(workflow).not.toContain("Get PR number");
      expect(workflow).not.toContain("steps.pr-details");
      expect(workflow).not.toContain("<pr_description>");
      expect(workflow).toContain("token_permissions: NO_PUSH");
      expect(workflow).not.toMatch(/top-level (?:PR|pull request) comment/i);
      expect(workflow).not.toMatch(/review summary/i);
    },
  );

  it("keeps review delivery rules in the harness guidance instead of workflow prompts", () => {
    expect(guidance).toContain("one empty-body review");
    expect(guidance).toContain("body exactly `LGTM!`");
    expect(repositoryReviewWorkflow).not.toContain("LGTM!");
    expect(generatedReviewWorkflow).not.toContain("LGTM!");
  });

  it("keeps one explicit Bonk extension and GitHub credentials out of the Pi step", () => {
    expect(resultExtension.match(/registerTool\(/g)).toHaveLength(1);
    expect(resultExtension).toContain('name: "submit_result"');
    expect(runPiScript.match(/extensions\/bonk-result\.ts/g)).toHaveLength(1);

    const runStep = action.slice(action.indexOf('- name: "Run: Pi"'), action.indexOf('- name: "Finalize:'));
    expect(runStep).toContain("BONK_RESULT_PATH");
    expect(runStep).not.toContain("GH_TOKEN");
    expect(runStep).not.toContain("OIDC_BASE_URL");
    expect(runStep).not.toContain("GITHUB_TOKEN");
  });

  it("preserves legacy inputs and repository agent configuration", () => {
    expect(action).toContain("opencode_version:");
    expect(action).toContain("opencode_dev:");
    expect(action.match(/Accepted but ignored\./g)).toHaveLength(2);
    expect(action).toContain("agent:");
    expect(runPiScript).toContain("/.agents/skills");
    expect(runPiScript).toContain("/.agents/agents/");
    expect(runPiScript).toContain("/.opencode/agents/");
  });
});
