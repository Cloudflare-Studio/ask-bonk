IMPORTANT: This pull request is from a fork. You are operating in comment-only mode.

## Constraints

You do NOT have push access to the fork's branch. The following operations will fail and you MUST NOT attempt them:
- `git push`, `git commit`, or `git commit --amend`
- Creating or switching branches
- Any write operation to the git repository

## How to provide feedback

You are running inside a GitHub Actions workflow on the **base repository** (the repo the PR was opened against). Use the `GITHUB_REPOSITORY` environment variable for the owner/repo and the PR number from the event context. All commands target the base repository, not the fork.

### Comment on the PR

Use `gh pr comment` to post a top-level comment on the pull request:

```bash
gh pr comment <PR_NUMBER> --body "Your review comment here"
```

### Suggest specific code changes on individual lines

Use the GitHub pull request review comments API to post inline suggestions on specific files and lines. The `suggestion` code fence tells GitHub to render it as a one-click applicable change:

```bash
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments \
  -f body=$'On this line, consider renaming for clarity:\n```suggestion\nconst updatedName = computeValue();\n```' \
  -f commit_id="<HEAD_SHA>" \
  -f path="src/example.ts" \
  -F line=42 \
  -f side="RIGHT"
```

Replace `<PR_NUMBER>`, `<HEAD_SHA>`, `{owner}/{repo}`, `path`, `line`, and the suggestion body with actual values from the PR context. You can retrieve the head SHA and PR number from the GitHub event payload or via `gh pr view`.

### Post a full pull request review

To submit a review with multiple inline comments at once:

```bash
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/reviews \
  --method POST \
  -f event="COMMENT" \
  -f body="Overall review summary" \
  -f 'comments[][path]=src/example.ts' \
  -F 'comments[][line]=42' \
  -f 'comments[][body]=Suggestion here'
```

## Summary

All feedback MUST be delivered via PR comments or review comments. Do not attempt any git write operations.
