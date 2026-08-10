import { describe, expect, it } from "vitest";
import repositoryReviewWorkflow from "../.github/workflows/review.yml?raw";
import generatedReviewWorkflow from "../cli/templates/review.yml.hbs?raw";
import guidance from "../github/bonk_guidance.md?raw";

const reviewPrompt = [
  "Review this pull request for discrete, actionable defects introduced by the change.",
  "Inspect the diff, relevant surrounding code, and applicable repository instructions.",
  "Ignore non-blocking style preferences and speculative concerns. Report every qualifying finding in severity order.",
].join("\n");

describe("Bonk prompt contract", () => {
  it("assigns top-level delivery to OpenCode without claiming exactly-once enforcement", () => {
    expect(guidance).toContain(
      "The `opencode github run` CLI, not the model, owns delivery of the top-level issue or pull request response.",
    );
    expect(guidance).not.toMatch(/exactly once/i);
    expect(guidance).not.toContain("If no findings remain");
    expect(guidance).toContain("If the review found no actionable issues at all");
  });

  it("gives explicit change requests precedence in mixed review-and-fix tasks", () => {
    expect(guidance).toContain("Determine authorization from the entire request.");
    expect(guidance).toContain(
      "treat the task as a change request even when it also asks for a review or diagnosis",
    );
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
      expect(workflow).not.toMatch(/top-level (?:PR|pull request) comment/i);
      expect(workflow).not.toMatch(/review summary/i);
    },
  );

  it("keeps review delivery rules in the harness guidance instead of workflow prompts", () => {
    expect(guidance).toContain("one `COMMENT` review");
    expect(guidance).toContain("return exactly `LGTM!`");
    expect(repositoryReviewWorkflow).not.toContain("LGTM!");
    expect(generatedReviewWorkflow).not.toContain("LGTM!");
  });
});
