# Use case: three pipelines, one rule set

Sam uses `implement-to-pr` for tasks and plans, `finish-pr` to land half-done
PRs and `ticket-to-pr` for tracker tickets.

1. Each pipeline links to the same `reference/delivery-rules.md`, so all three
   isolate the same way: a worktree off `origin/main` for new work, or on the
   PR's head branch for an existing PR. They also update from `main`, track the
   ticket, brief subagents, pick subagent models, fix findings and treat CI the
   same way.
2. Sam changes the rules once, in `implement-to-pr`'s copy, and runs
   `npm run sync-shared`. The test suite fails if any copy drifts.
3. Sam has a plan that needs a second look, so they run
   `/implement-to-pr docs/plans/billing.md --review-plan --merge`. Claude
   reviews the plan against the code, lists the changes it made to it, writes
   the implementation plan into the repo's `plans-dir`, builds it, opens and
   reviews the PR, and merges once CI is green. Without `--merge` it stops at a
   reviewed, green PR.
4. Muscle memory makes Sam reach for `/ship-plan`, but 0.7.0 removed it: the
   skill is gone from the plugin, and the installer and `/update` take an old
   copy out. The README says to use `/implement-to-pr --review-plan --merge`
   instead (without `--merge` for the old `--no-merge`), and no skill or doc
   outside the changelog and old plans still points Sam at `ship-plan`.
5. No pipeline merges without its documented opt-in: `implement-to-pr` only
   with `--merge`, `finish-pr` never, and `ticket-to-pr` only when Sam picks
   "merge". The delivery rules' "Which pipeline" table says the same.
6. When a PR touches UI, every pipeline runs the one UI gate defined in the
   delivery rules: `ui-critique-loop --score <N>` on each surface, then the UX
   and Design persona review. `--no-ui` skips it. Overdrive isn't part of it;
   Sam runs `/ui-finalize` when they want that.
7. `implement-to-pr` and `finish-pr` each carry a Stop hook. A run that tries
   to stop with a progress report is sent back to work. It can only end with an
   `IMPLEMENT-` or `FINISH-` `COMPLETE:` line (or `BLOCKED:` with the reason).
   Each gate stays in place until it lets the run stop.
8. `/new-project` hands its plan to `implement-to-pr`, so that skill can be
   invoked by Claude as well as typed. It still never merges without `--merge`.
   A brand-new repo with no GitHub remote gets a reviewed local branch instead
   of a PR.
9. The rules keep each session in one repo. Work in a second repo goes to a
   worktree-isolated subagent or a session of its own, so the working folder
   never switches mid-task.
10. Each pipeline rewrites its `/pr-dashboard` status line when its PR changes,
    so dashboards read current lines instead of messaging the session. When the
    merge gate is on, a denied merge makes the pipeline ask Sam for
    `approve merge #N`.
