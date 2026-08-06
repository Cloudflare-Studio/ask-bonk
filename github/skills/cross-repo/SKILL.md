---
name: cross-repo
description: Access or change another repository only when the user explicitly requests a cross-repository task.
---

# Cross-repository GitHub access

Use Bonk's token wrapper for every `gh` or `git` command that targets another repository. The server grants a short-lived token only when the target is in the same organization, the triggering actor has write access, and the source repository's visibility may access the target.

```bash
bun run "$BONK_ACTION_PATH/script/cross-repo.ts" owner/repo -- gh pr list --repo owner/repo
bun run "$BONK_ACTION_PATH/script/cross-repo.ts" owner/repo -- gh repo clone owner/repo /tmp/target-repo
bun run "$BONK_ACTION_PATH/script/cross-repo.ts" owner/repo -- git -C /tmp/target-repo push origin HEAD
```

Do not print, persist, or request the token directly. Keep the target exact, inspect existing state first, and make cross-repository changes only when the user explicitly authorized them.
