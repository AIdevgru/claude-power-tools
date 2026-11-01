---
name: drain-pr-queue
description: "Merge every mergeable, green PR one at a time with a head-SHA guard, fixing conflicting branches in worktrees, until none remain or each leftover has a stated blocker. Explicit invocation only: '/drain-pr-queue', 'merge all open PRs' or 'keep merging until none remain'."
user-invocable: true
disable-model-invocation: true
argument-hint: "[PR numbers to limit to] [--include-drafts] [--method squash|merge|rebase]"
---

# Drain the PR queue

This is a live repository mutation: it merges PRs into the base branch. Run it only because the user explicitly asked for it. If you were invoked any other way, confirm before the first merge.

**Input:** `$ARGUMENTS`
- PR numbers limit the queue to those PRs. Without them, the queue is every open PR on the default branch.
- `--include-drafts`: also merge drafts. Without it, drafts are skipped.
- `--method`: the merge style. Without it, use the repo's documented convention, else the style recent merges on `main` used (read `git log --first-parent --oneline -10 origin/main`: "Merge pull request" commits mean merge, single commits ending in `(#<n>)` mean squash), else squash.

## Rules

- **Repo rules win.** Read `CLAUDE.md`/`AGENTS.md` first. If merging to `main` deploys, say so before the first merge, and respect any rule that merges go one at a time with `main` green in between.
- **Preserve user work.** Run `git status --short --branch` first. Never reset, check out over, delete or revert local changes you didn't make. Resolve conflicts in a dedicated worktree, never in a dirty main checkout.
- **Green means green:** total checks > 0 and no failing required checks. "0 checks + mergeable" is not green. Don't merge a PR with failing required checks unless the user explicitly accepts that risk for that PR.
- **Respect ownership.** A PR another live session claims (title tag `[<session>]`, a request-inbox claim, or its status) is updated only with that session's agreement; message it instead.
- **Never** force-push, use `--no-verify`, bypass branch protection (`--admin`), or deploy.

## Merge loop

1. **Discover.**
   - `git remote -v`, `git status --short --branch`, `git worktree list`.
   - `gh pr list --state open --json number,title,isDraft,mergeable,mergeStateStatus,baseRefName,headRefName,headRefOid,statusCheckRollup`.
   - Note each PR's draft state, mergeability, base, head branch and head SHA.

2. **Merge what is ready**, smallest risk first, one at a time:
   - Re-read the PR right before merging (`gh pr view <n> --json headRefOid,mergeable,mergeStateStatus,statusCheckRollup`); GitHub's list data can be stale.
   - Merge with an expected-head guard: `gh pr merge <n> --<method> --match-head-commit <sha>`.
   - Confirm the merge commit on the base branch (`gh pr view <n> --json mergeCommit,state`).
   - If the repo requires `main` to be green between merges, wait for the new `main` commit's CI before the next merge.

3. **Resolve PRs that conflict with the base.**
   - `git fetch origin <base> <head>`, then use the PR branch's existing worktree or create one: `git worktree add ../<repo>-pr-<n> <head-branch>`.
   - `git merge origin/<base>` into the PR branch. Never rebase a shared branch.
   - Resolve each conflict by preserving the intended behaviour of both sides; read the base commits that touched the file. Regenerate generated files instead of hand-merging them.
   - Check for leftover markers: `git grep -n -E "^(<<<<<<<|=======|>>>>>>>)( |$)"`.
   - Run `git diff --check`, plus focused tests or the checks the PR body names.
   - Commit the merge and push the PR branch.
   - Wait for GitHub to report the new head and mergeability, and for its CI. Then merge it with the new head SHA as the guard.

4. **Repeat.** After every merge, list the open PRs again: new PRs appear, and each merge changes the others' mergeability. Stop when no PR in scope remains, or every remaining one has a blocker: a failing required check that is the PR's own, missing permissions, no branch access, a conflict that can't be resolved safely, or an ownership claim.

## Final report

- merged PRs with their merge SHAs, in order
- branch updates (PR, new head SHA, what was resolved)
- tests and checks run or skipped
- every PR left open, with its exact blocker
- confirmation that no mergeable PR remains in scope
