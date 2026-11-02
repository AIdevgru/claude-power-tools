# Use case: one ticket to a reviewed PR

Lee has ticket ABC-12 and wants it built, reviewed and ready for his decision.

1. He types `/ticket-to-pr ABC-12`. A GitHub issue is `#42`. If the key is missing, the skill asks once. `--no-ui` skips the UI gate, and `--score N` sets its threshold.
2. The skill reads the repo's `CLAUDE.md` for how to act on a ticket and for the tracker settings: Jira ids and transitions, or the `in-progress` and `in-review` labels for GitHub.
3. It hands the build to a background `general-purpose` agent with a full brief. The agent makes its own worktree off `origin/main` on a branch named `<type>/<key>-<slug>`.
4. The agent moves the ticket to In Progress and assigns it, then implements with tests. It runs the suite before changing tests and again after.
5. The agent opens the PR with a body that links the ticket, comments the PR link on the ticket, runs `/code-review high`, fixes every confirmed finding and waits for green CI.
6. Back in Lee's session, if the change touches UI, the UI gate runs in the agent's worktree. It runs here because it needs its own reviewer and fix subagents.
7. The skill posts its take as a PR comment, then moves the ticket to In Review.
8. It asks Lee with `AskUserQuestion`: merge or hold.
9. On merge it re-checks CI on the current head, merges, moves the ticket to Done and cleans up the worktree. On hold it records the reason on the ticket and the PR and leaves the worktree in place. It never merges without the explicit merge choice.
