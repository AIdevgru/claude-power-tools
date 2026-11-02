# Use case: combining four open PRs into one

Lee has four open PRs, and they keep re-queuing CI because they touch the same files. Other sessions or people may own those branches.

1. He types `/combine-prs 101 104 105 108`. Without numbers, the skill lists the open PRs and asks which to combine.
2. The skill asks one more thing: close the originals afterwards, or leave them open.
3. It records each PR's head branch, head SHA and size, and notes stacked PRs so none is merged twice.
4. It builds an integration branch off fresh `origin/main` in its own worktree. It trial-merges each PR, smallest first. Clean ones stay in. A conflicting one is aborted and listed.
5. One subagent per conflicting PR resolves it in its own `merge/combined-<n>` worktree. Then the branches are merged in pairs, level by level, until one is left.
6. The full gate runs once, on the final branch.
7. It opens one PR that lists every source PR and how each conflict was resolved.
8. The original branches are never pushed to, rebased or force-pushed. The skill never merges the combined PR and never deploys. It closes the originals only if Lee chose that in step 2.
