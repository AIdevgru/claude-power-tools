# Use case: finishing a half-done PR

Lee has PR #196. The author stopped midway. He wants it done and reviewed, but not merged.

1. He types `/finish-pr 196`. Adding `--no-ui` skips the UI gate, and `--score N` sets its threshold. The default is 38.
2. The skill reads the PR, its comments and its plan or handoff doc. It renames the window after the work.
3. It brings the branch up to date with `main` before any new work. It never takes "ours" or "theirs" wholesale.
4. It writes a checkable "Remaining work" list. That list is the definition of done.
5. Subagents with separate files build the remaining items. Then the full gate runs.
6. `code-review` runs at `high`. Findings are fixed, and a second review runs over the whole diff. It repeats until no findings are open.
7. If the PR touches UI, the UI gate runs. Otherwise it is skipped with a note.
8. The skill re-checks every item against the code and updates the PR body.
9. It stops at a reviewed, green PR and never merges into `main`. A Stop hook keeps it going until the last message has a `FINISH-COMPLETE:` line, or a `FINISH-BLOCKED:` line that names the blocker.
