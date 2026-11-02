# Use case: taking a plan to a reviewed PR

Lee has a plan doc for a new feature. He wants it built and reviewed, and he wants to merge it himself.

1. He types `/implement-to-pr docs/plans/export.md --review-plan`. The input can also be a task, a ticket key or a PR number.
2. The skill reads the repo's `CLAUDE.md` for a `## Power tools` section: tracker, push command, PR title format, merge method and plans folder.
3. It reads the plan and the code, and moves any ticket to In Progress.
4. Because of `--review-plan`, it checks the plan against the real code, rewrites it, and asks Lee only about decisions that are his. It writes a dated plan file in the plans folder.
5. Subagents split by file ownership build the work. The full gate runs and must be green.
6. It opens the PR, then runs `code-review` at `high`, fixes the findings, and reviews again until none are open.
7. If the PR touches UI, the UI gate runs, unless Lee passed `--no-ui`. `--score N` sets the threshold.
8. It waits for CI on the exact head commit. Once green, the ticket moves to In Review.
9. Lee did not pass `--merge`, so the skill does not merge. It leaves a ready PR. With `--merge` it merges only when CI is green, the last review is clean and the PR is up to date with `main`.
10. A Stop hook keeps it going until the last message has an `IMPLEMENT-COMPLETE:` line, or an `IMPLEMENT-BLOCKED:` line.
