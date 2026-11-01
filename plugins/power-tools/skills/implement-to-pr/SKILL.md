---
name: implement-to-pr
description: "Build a task, plan, ticket or handoff doc with subagents, open a PR, and review it until clean. --review-plan improves the plan first; --merge merges once green. Trigger on '/implement-to-pr', 'implement this and open a PR', or 'take this plan to a reviewed PR'."
user-invocable: true
disable-model-invocation: false
argument-hint: "<task, plan path, ticket key or PR number> [--review-plan] [--merge] [--no-ui] [--score N]"
hooks:
  Stop:
    - hooks:
        - type: prompt
          once: true
          prompt: |
            You are the completion gate for an `/implement-to-pr` run (goal: complete the implementation, use subagents, create a PR, review the PR, and merge it only if `--merge` was supplied).
            Read the hook input below. Look at the assistant's last message.
            - If it contains a line starting `IMPLEMENT-COMPLETE:` that names a PR URL and states the review result (and, when merge was requested, that the PR is merged), return {"ok": true}.
            - If it contains a line starting `IMPLEMENT-BLOCKED:` that states a concrete blocker or a decision only the user can make, return {"ok": true}.
            - Otherwise return {"ok": false, "reason": "The /implement-to-pr goal is not met yet. Continue: run the next unfinished stage (plan review if --review-plan, implementation with subagents, the PR, its review and fixes, the UI gate, CI, and the merge if --merge was supplied), then end with an IMPLEMENT-COMPLETE line (or IMPLEMENT-BLOCKED with the reason)."}
            Hook input: $ARGUMENTS
---

# Implement to PR

Treat this as the session goal, exactly as if the owner had typed:

> `/goal complete implementation: <input>. Use subagents. Create PR. Review PR.` plus `Merge PR.` only when `--merge` is supplied.

**Input:** `$ARGUMENTS`

- `--review-plan`: review and improve the plan against the real code, and write an implementation plan, before building (stage 2).
- `--merge`: merge the PR once it is green and reviewed (stage 8). Without it, stop at a reviewed, green, ready-for-review PR and **do not merge**.
- `--no-ui`: skip the UI gate (stage 6) even if the PR touches UI.
- `--score N`: the UI gate's score threshold (default 38, so 39/40 or better passes).
- Remove the flags. The rest is the task: a description, a plan or issue, a handoff or checkpoint doc path, a ticket key (`ABC-12`, `#42`), or a PR number. If it's a path, ticket or PR, read it fully first. Its own "resume" or "remaining" steps and completion requirements become the definition of done.
- If the input is empty, ask once what to implement, then proceed.

The skill's Stop hook keeps you working until you end a message with an `IMPLEMENT-COMPLETE:` or `IMPLEMENT-BLOCKED:` line, so don't stop early and don't wrap up with a partial summary. The hook clears itself once it lets you stop.

## Repo settings

Read the repo's `CLAUDE.md` and `AGENTS.md` first. If either has a `## Power tools` section, it sets:
- `tracker:` `jira` (with `jira-cloud-id`, `jira-project` and `jira-transitions`), `github` or `none`;
- `push:` the push command (default `git push`);
- `pr-title:` the PR title format (default `<type>(<scope>): <summary>`);
- `merge-method:` `squash` (default), `merge` or `rebase`;
- `plans-dir:` where plans go (default `docs/plans/`).

Anything the repo's own instructions say about these wins.

## Ground rules

Follow [reference/delivery-rules.md](reference/delivery-rules.md): isolation (a worktree off `origin/main` for new work, or on the PR's head branch for an existing PR), tracking the ticket, subagents and their models, fixing findings, tests, the UI gate, green CI and the never-list. Merging happens only with `--merge`. A repo with no GitHub remote gets a reviewed local branch instead of a PR, as the rules describe.

## Stages

Report one line per stage as you go (`Stage 3/8 done: ...`). Optional stages that don't apply get a one-line skip note.

1. **Scope.** Read the input and the code it touches. A number is `gh pr view <n>`, or `gh issue view <n>` if no PR has that number; a Jira key is read from the tracker. If the work has a ticket, move it to In Progress (see "Track it" in the delivery rules). Without `--review-plan`, write a checkable definition of done, either in the plan or handoff doc or as the PR's checklist.
2. **Review the plan** (optional: only with `--review-plan`).
   - **Review and improve it.** Check the plan against the real code: wrong file paths, missing edge cases, auth, privacy and security gaps, migration ordering, test coverage, rollout or flagging, and anything that contradicts `AGENTS.md` or `CLAUDE.md`. Rewrite the plan with the improvements and keep a short "Changes to the plan" list. Ask with `AskUserQuestion` (recommended option first) only for decisions that are genuinely the owner's, such as product behaviour, a security trade-off or cost. Otherwise decide and note it.
   - **Write the implementation plan** to `<plans-dir>/<yyyy-mm-dd>-<short-name>.md` (UTC date). Include ordered steps with the files and functions per step, data and migration changes, API changes, the test plan (unit, integration, end-to-end), rollout or flags, and the definition of done. Each step should be checkable; tick them off as stage 3 completes them.
3. **Implement with subagents.** Split the work into chunks by file ownership. Integrate each result and run its focused tests. Then run the repo's full gate (typecheck, lint, unit/integration, relevant end-to-end, build). Don't move on while anything is red.
4. **Create the PR.** Commit with conventional messages, push the branch with the repo's push command and open the PR titled per the repo's format, or update it if one exists. Without a GitHub remote, commit on the branch and treat it as the PR from here on. The body covers the summary, a link to the plan file (if any), the checks run with results, and anything left open, and ends with the repo's attribution line if it has one.
5. **Review the PR.** Run `code-review` at `high` on the PR. Hand the verified findings to subagents to fix, re-run the affected tests and push. Then review again until a pass comes back with no open findings. Add any reviews the input requires (security, extra personas), using fresh subagents.
6. **UI gate** (optional: only when the PR touches UI and `--no-ui` wasn't given). Run the UI gate in [reference/delivery-rules.md](reference/delivery-rules.md) with threshold N. If it changed code, run stage 5's review once more over the whole diff and fix what it finds.
7. **CI.** Wait for the PR's required checks on the exact head commit (`gh pr checks <n> --watch --interval 180`). Diagnose failures and fix the real ones. Re-run only failures you can show are infrastructure flakes. Once CI is green, move the ticket to In Review.
8. **Merge** (optional: only with `--merge`). Merge only when all of these hold:
   - CI is green: more than 0 checks and 0 failures on the head commit. Zero checks plus "mergeable" is not green.
   - The last review has no open findings.
   - Migration order is respected: lower-numbered migrations from other PRs merged first.
   - The PR is up to date with `main`. If not, merge `main` in, re-run CI and wait again.

   Then mark the PR ready, merge it with the repo's method (`gh pr merge <n> --squash` by default), confirm the merge commit on the base branch, move the ticket to Done with the merge SHA, and clean up the worktree as the delivery rules describe. Without `--merge`, leave the PR ready for review.

## Finish

Keep the final report short: the PR and merge SHA (or "not merged"), the ticket key and plan path if any, the stages run or skipped (with reasons), the findings fixed per review, the UI score per surface, and anything left for the owner (this skill never deploys).

End the final message with exactly one line:
- `IMPLEMENT-COMPLETE: <PR URL> — review: <clean | N findings fixed>; UI: <score per surface | no UI | skipped>; CI: <green>; merged: <yes, SHA | not requested>`
- or `IMPLEMENT-BLOCKED: <the blocker, or the numbered decision the owner must make>`
