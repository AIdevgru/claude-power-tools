---
name: finish-pr
description: "Finish an open PR, issue or task with subagents: update from main, list the remaining work, build it, review twice and fix, and run the UI gate for UI changes. Stops at a reviewed, green PR; never merges. Trigger on '/finish-pr <n>', 'finish #<n>', or 'get #<n> done'."
user-invocable: true
disable-model-invocation: false
argument-hint: "<PR number, issue number, URL or task> [--no-ui] [--score N]"
hooks:
  Stop:
    - hooks:
        - type: prompt
          once: true
          prompt: |
            You are the completion gate for a `/finish-pr` run (goal: finish the PR, issue or task to a reviewed, green PR; it never merges).
            Read the hook input below. Look at the assistant's last message.
            - If it contains a line starting `FINISH-COMPLETE:` that names the PR (or branch) and its review result, return {"ok": true}.
            - If it contains a line starting `FINISH-BLOCKED:` that states a concrete blocker or a decision only the user can make, return {"ok": true}.
            - Otherwise return {"ok": false, "reason": "The /finish-pr goal is not met yet. Continue: work through the Remaining work list, review and fix, run the UI gate when the PR touches UI, and re-check completeness. Then end with a FINISH-COMPLETE line (or FINISH-BLOCKED with the reason)."}
            Hook input: $ARGUMENTS
---

# Finish a PR

Treat this as the session goal, exactly as if the user had typed:

> `/goal Finish <input>. Review for completeness. Use subagents if useful to finish quickly.`

It stays the goal until it is met. Don't stop at a progress report while work you can do yourself remains: the skill's Stop hook keeps the run going until a message ends with a `FINISH-COMPLETE:` or `FINISH-BLOCKED:` line. If a `/goal` command is available, also invoke it with that line.

**Input:** `$ARGUMENTS`
- `--no-ui` skips the UI gate (stage 6).
- `--score N` sets the UI gate's score threshold (default 38, so 39/40 or better passes). The old single-dash `-score N` is still accepted until 0.7.0.
- The rest is the target. If it is empty, ask once what to finish, then proceed.

Report one line per stage as you go (`Stage 2/7 done: ...`) and nothing more until the end.

## Ground rules (every stage)

Follow [reference/delivery-rules.md](reference/delivery-rules.md): isolation (an existing PR, so a worktree on its head branch), updating from `main`, tracking the ticket (up to In Review), subagents and their models, fixing findings, tests, the UI gate, green CI and the never-list. In addition:

- **This skill never merges into `main`.** Pushing to the PR's head branch is fine, using the repo's push command.
- Do small items yourself rather than spawning a subagent for them.

## Stages

1. **Load the target.**
   - A number (`#196`, `196`) or URL: `gh pr view <n>`, or `gh issue view <n>` if no PR has that number. Otherwise treat the input as a task description and find its branch, PR, plan or handoff doc.
   - Read the body, comments, linked plan/handoff/review docs, checks and the code it touches.
   - For an issue or task with no PR yet, finishing means implementing it and opening a PR per the repo's PR rules (a draft if the repo uses drafts).
   - **Name the window after the work:** run `/rename finish <target>: <short title>` (the PR/issue number and its title cut to about 40 characters, or a 3–5 word summary). If `/rename` can't be run from here, give the user the exact line in the first progress message and carry on.

2. **Bring the branch up to date with main.** Do this before new work, and again before the final review if `main` has moved.
   - `git fetch origin`, then `git rev-list --count HEAD..origin/main`.
   - Merge or rebase as the delivery rules say (merge by default). Never take "ours" or "theirs" wholesale to make a conflict go away. Use a subagent per conflicting area when there are many.
   - After resolving: typecheck, lint and the tests touching the conflicted files, then commit the merge and push.

3. **Define "done".** Write a checkable "Remaining work" list in the PR's plan or handoff doc (or the PR body): unchecked plan steps, outstanding/TODO lists, unresolved review comments, failing CI or tests, missing tests and use-case stories, docs. This list is the definition of done.

4. **Implement with subagents.** Split the remaining work into independent chunks with disjoint file ownership. Spawn subagents in parallel where the chunks are independent, and in order where they depend on each other. As each returns, integrate its work, tick its items, and run its focused tests. When every item is ticked, run the repo's full gate (typecheck, lint, unit/integration, relevant end-to-end specs, docs checks). Don't move on while anything is red. Commit with conventional messages and push.

5. **Review twice and fix.** Run the `code-review` skill at `high` on the PR. Hand the verified findings to subagents, grouped by file ownership, then re-run the affected tests and push. Run `code-review` a second time over the whole diff, including the fixes. Repeat until a review comes back with no open findings.

6. **UI gate** (only when the PR touches UI and `--no-ui` wasn't given; otherwise skip it with a one-line note). Run the UI gate in [reference/delivery-rules.md](reference/delivery-rules.md) with threshold N: the `ui-critique-loop` score gate on each touched surface, then the UX and Design persona review. If the gate changed code, run stage 5's review once more over the whole diff and fix what it finds.

7. **Review for completeness, then finish.**
   - Re-check every "Remaining work" item against the code, not memory, and check the PR against its plan: each planned step is done, or the gap is stated in the PR body.
   - Run the narrowest relevant tests, then the repo's required gate, and report the commands and results faithfully.
   - Repeat stages 4–7 until the list is empty.
   - Update the PR body: what was done, checks run, anything left. If the repo uses a "ready to combine" or draft convention, follow it.

## Final report

Keep it short:
- the PR link, branch and final head SHA
- one line per "Remaining work" item: done, or left and why
- findings fixed per review stage (counts), and any rejected with reasons
- the UI score per surface and the persona findings fixed or deferred (or "no UI")
- CI status from `gh pr checks <n>`
- anything left for the owner. This skill never merges into `main` or deploys.

End with exactly one line:
- `FINISH-COMPLETE: <PR URL> — review: <clean | N findings fixed>; UI: <score per surface | no UI>; CI: green`
- or `FINISH-BLOCKED: <the blocker, or the numbered decision the owner must make>`
