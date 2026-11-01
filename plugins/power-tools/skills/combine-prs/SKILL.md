---
name: combine-prs
description: "Combine several open PRs into one integration PR: trial-merge each, fold in the clean ones, resolve conflicts with parallel subagents in a pairwise tree, validate once, open one PR. Never touches the source branches or merges. Trigger on '/combine-prs', 'combine these PRs into one' or 'one big PR'."
user-invocable: true
disable-model-invocation: false
argument-hint: "[PR numbers, e.g. 101 104 105 108] (omit to choose from the open list)"
---

# Combine PRs

Combine the PRs in `$ARGUMENTS` into one integration branch and one new PR, using subagents and a mergesort-style pairwise merge to keep wall-clock time low. Report one line per phase (`Phase 3/6 done: ...`) and nothing more until the end.

## Ground rules

- **Repo rules win.** Read the repo's `CLAUDE.md`/`AGENTS.md` first and follow them (worktree isolation, inbox and ownership protocols, tests and stories, migration rules, timestamps).
- **Never touch the original PR branches.** No pushes, rebases or force-pushes to them; another session (Claude, Codex or a human) may own them. If the repo has a request inbox (see the `request-inbox` skill), check its `in-progress/` and recent `done/` files for ownership claims on each PR, and say which ones are owned elsewhere.
- **Never** merge the combined PR, deploy, use `--no-verify` or force-push. Pushing the new integration branch and helper `merge/*` branches is fine, with the repo's push command.
- **Isolate.** Every merge runs in its own worktree created from a fetched commit (`git worktree add -b <branch> <path> <sha>`). Never `git checkout` or `git stash` in the main checkout. Use absolute paths and `git -C` everywhere.
- **Keep validation light while merging.** Parallel merge agents run only typecheck, targeted lint, pure unit tests and cheap tooling tests: no browsers, dev servers, database integration suites or full lanes, because parallel heavy runs exhaust memory. The full gate runs once, on the final branch.

## Phases

1. **Choose the PRs.** If `$ARGUMENTS` is empty, run `gh pr list --state open` and ask with `AskUserQuestion` which set to combine (recommend feature PRs only; keep docs, CI/deploy and long-stalled stacks separate unless asked). Also ask whether the originals should be closed with a link afterwards, or left open. For each PR record its head branch, head SHA, base and size (`git rev-list --count origin/main..origin/<branch>`, changed files). Note stacked PRs (one head contains another) so they aren't merged twice.

2. **Trial-merge to sort.** Create the integration worktree off fresh `origin/main` on branch `feat/combined-<short-name>`. Merge each PR in order of increasing size with `git merge --no-ff --no-edit -m "Merge #<n> (<branch>) into combined release"`. Keep a clean merge. On a conflict, record the conflicted files and run `git merge --abort`. Result: base **A** = main + every clean PR, plus a list of conflicting PRs with their files. Trivially small conflicts (one doc line, one config key) you resolve yourself in A.
   - **Check the auto-merged files for semantic breakage too.** A clean textual merge can still be wrong: two server blocks for the same host in a proxy config, duplicate routes, a migration ordering clash, two package scripts with the same name, or a later PR that supersedes an earlier one's temporary change. For every file touched by two or more of the merged PRs, read the merged result. When one PR deliberately replaces another's change, take the superseding version and say so.
   - Commit A and push it.

3. **Pairwise-resolve the conflicting PRs in parallel (leaf level).** Spawn one subagent per conflicting PR, all in one message. Each one gets:
   - the base SHA of A, its PR number and branch, and the conflicted files from phase 2;
   - its own worktree created exactly as `git worktree add -b merge/combined-<n> <path> <A-sha>`, with dependency folders (such as `node_modules`) linked from an existing worktree rather than reinstalled, and no regeneration of shared generated clients;
   - instructions to resolve each conflict by understanding both sides (`gh pr view` for both PRs, `git log -p --merge -- <file>`), keeping both features working and adapting where they overlap, and to check auto-merged files touched by both sides for semantic breakage;
   - the light validation set: typecheck, lint on touched files, focused pure unit tests, cheap tooling tests and `git diff --check`, keeping the repo's line endings;
   - instructions to commit with the repo's attribution, push `merge/combined-<n>`, and return the SHA, one line per conflict resolution, the checks with counts, and anything uncertain.

   Give the agents a full brief; they don't inherit your context. Leave their model unset: resolving conflicts needs judgment.

4. **Reduce pairwise (mergesort levels).** Pair up the returned `merge/combined-*` branches. For each pair, spawn a subagent, in parallel, that creates a worktree from the first branch, merges the second, resolves conflicts between those two PRs only (the shared base A is already in both), validates lightly and pushes `merge/combined-<n>-<m>`. Repeat level by level until one branch remains. With an odd count, carry the leftover branch up a level unchanged. If a level has only one pair with no conflicts, do it yourself instead of spawning an agent.

5. **Validate once, fully.** Fast-forward `feat/combined-<short-name>` to the final branch. In that worktree run the repo's full gate: typecheck, lint, unit and integration lanes, the relevant end-to-end lanes (one at a time if dev servers lock per directory), docs and tooling checks. Diagnose and fix failures; hand large fixes to subagents grouped by file ownership. Compare any failure with `origin/main` before blaming the merge. Push.

6. **Open the combined PR.** Open one PR from `feat/combined-<short-name>` to `main`.
   - If the repo's rules say source PRs stay drafts and only the combined PR runs CI, mark the combined PR ready once every source PR is finished (`Status: ready to combine`, or its owner said so). Leave it a draft only while a source still has open work. Without such a rule, open it as a draft if any source PR was a draft or work is still open.
   - Its body lists every source PR (number, title, one line), how each conflict was resolved, superseded changes, the checks and results, and anything owned by another session.
   - Only if the user chose it in phase 1, close each original PR with a comment linking the combined PR (`gh pr close <n> --comment "Combined into #<new>"`); leave their branches in place.
   - Remove the `merge/*` worktrees once the combined branch contains them (unlink any dependency-folder links first); keep the remote `merge/*` branches until the combined PR merges.

## Final report

Keep it short:
- the combined PR number, branch and head SHA
- source PRs: merged clean, resolved (one line per resolution) and skipped (with reason)
- the mergesort tree: leaf and reduce merges, with the agent count
- the full-gate results with counts, and CI status from `gh pr checks <new>`
- originals closed or left open, plus anything owned by another session or left for the owner. This skill never merges or deploys.
