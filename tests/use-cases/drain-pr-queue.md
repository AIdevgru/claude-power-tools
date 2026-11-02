# Use case: draining the PR queue

Lee has six open PRs. Four are green and two are not. He wants them merged without babysitting.

1. He types `/drain-pr-queue`. It is explicit-invocation only, because it merges into the base branch.
2. The skill checks `git status` first and never resets or reverts local changes. It lists open PRs with their draft state, mergeability, head branch and head SHA.
3. Drafts are skipped unless Lee adds `--include-drafts`. The merge style comes from `--method`, else the repo's convention, else recent merges on `main`, else squash.
4. Before each merge it re-reads the PR. It merges with `--match-head-commit <sha>`, so a branch that changed in the meantime is not merged by mistake. Then it confirms the merge commit.
5. A PR with 0 checks is not green, and one with failing required checks is not merged.
6. A PR that conflicts with the base gets `origin/<base>` merged into its branch in a worktree. The skill never rebases a shared branch. It pushes, waits for CI, and merges with the new head SHA.
7. After each merge it lists the open PRs again, and stops when none remain or each leftover has a stated blocker.
8. It never force-pushes, uses `--no-verify` or `--admin`, or deploys. A PR claimed by another live session is left alone, and that session is messaged instead.
