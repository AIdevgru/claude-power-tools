# Delivery rules

Shared by `implement-to-pr`, `finish-pr` and `ticket-to-pr`. Each of those skills ships an identical copy of this file. Edit the copy in `implement-to-pr`, then run `npm run sync-shared` in the claude-power-tools repo.

## Which pipeline

| Start from | Skill | Stops at | Merges |
|---|---|---|---|
| A task, plan, ticket, handoff doc or PR to build (`--review-plan` reviews and improves a plan first) | `implement-to-pr` | a reviewed, green PR | only with `--merge` |
| An existing PR or issue that needs finishing | `finish-pr` | a reviewed, green PR | never |
| One tracker ticket (Jira or GitHub issue) | `ticket-to-pr` | a reviewed PR, then the owner picks merge or hold | asks the owner |

## Rules

- **Repo rules win.** Read the repo's `CLAUDE.md` and `AGENTS.md` first, including any `## Power tools` section, and follow them: worktree isolation, tests and use-case stories, timestamp conventions, migration ordering, threat models, ticket tracking, draft-PR rules, inbox and ownership protocols.
- **Isolate.** Run `git status` and `git fetch origin`. Never `git checkout`, `switch`, `stash` or `pull` in the main checkout. Use absolute paths and `git -C` everywhere.
  - **New work:** `git worktree add <worktree-root, default ../<repo>-<short-name>> -b <type>/<short-name> origin/main`.
  - **An existing PR:** `git worktree add <path> <head-branch>`, then fast-forward it to `origin/<head-branch>`.
  - If another session or agent claims the branch or PR, check with the owner before pushing to it.
- **One repo per session.** Work in the repo the session started in. Work in a second repo goes to a subagent with `isolation: "worktree"` started from that repo, or to a session of its own, so your working folder and git context never switch mid-task.
- **Bring a branch up to date with `main`** by merging `origin/main` (the default for any pushed or shared branch). Rebase only a branch that was never pushed, or one only this session has pushed and nothing depends on; a rebased pushed branch needs `--force-with-lease`, so ask the owner first. Resolve conflicts by reading both sides (`git log origin/main -- <file>`) and keeping both intents. Regenerate lockfiles, generated clients and snapshots rather than hand-merging them.
- **Track it** when the repo uses a tracker (`tracker:` in the `## Power tools` section). Reuse the ticket the work came from or the PR links. Create a ticket for work that has none only when the repo's rules ask for one. Move it to In Progress before the first edit, to In Review when the PR is ready (reviewed, UI gate passed, CI green), and to Done on merge (with the merge SHA), with a comment at each step. With GitHub Issues, use the `in-progress` and `in-review` labels and put `Closes #<n>` in the PR body. A pipeline that never merges stops at In Review.
- **Subagents do the work; you orchestrate.**
  - Brief each one fully: the goal, the worktree path, the files it owns, the ports or database it may use, the acceptance checks and these rules. They don't inherit your context.
  - Give each file one writer at a time. Parallel writers either own disjoint files or run with `isolation: "worktree"` and return a branch you merge.
  - Reviewers are read-only and fresh. Don't tell them prior scores or verdicts.
  - You own integration, schema and migrations, trust boundaries, the final test runs and every push.
- **Pick each subagent's model on purpose.**
  - Leave it unset (inherit) for implementing, reviewing, resolving conflicts, debugging, and anything security-related.
  - Use `sonnet` for mechanical edits from a precise spec: a rename, a version bump, or a verified fix whose exact change is already known.
  - Use `haiku` for reading CI logs, listing or counting, and summarizing a file or diff. `Explore` agents already run on Haiku.
- **"Fix findings"** means fixing every finding you can verify as real. List any you reject with a one-line reason each, then re-run the affected tests.
- **Tests:** run the suite before changing tests and again after. Report raw failures, and never weaken an assertion to go green.
- **Green CI** means more than 0 checks and 0 failures on the exact head commit. GitHub can show cancelled runs as failures, so check the run's conclusion. Before calling a failure a flake, run a control on `origin/main`.
- **Never** use `--no-verify`, force-push a shared branch, bypass CI or queue policy, deploy, or merge on stale evidence. Merge only when the skill says so and the owner allowed it. The `git-guard` hook, when installed, blocks several of these. With its merge gate on, `gh pr merge <N>` also needs the owner's `approve merge #N`; when a merge is denied for that, ask for exactly that phrase.
- **Keep your status line current.** When your PR's state changes (opened, pushed, CI green or red, blocked, merged), rewrite `~/.claude/pr-dashboard/status/<your session name>.txt` (or `$PR_DASHBOARD_HOME/status/`; Read it first if it exists, because Write won't overwrite an unread file) with one line in the `/pr-dashboard` format: `<session> | <PR#s> | <doing, ≤10 words> | waiting on <…> | next push <…> | ask owner <…> | <ETA to green+mergeable>`. Dashboards read current lines instead of messaging you.
- **Memory:** before heavy builds or browser runs, check free RAM, and give parallel builds their own build or target folders.
- **Ask only for decisions that are the owner's** (product behaviour, security trade-offs, cost, anything that ships to production), using `AskUserQuestion` with the recommended option first. Otherwise decide, note it, and continue.
- **No GitHub remote:** work on a local branch, and review the branch diff instead of a PR (`code-review` with the branch as the target). "Open the PR" becomes "the branch is ready", and a merge is a local `git merge --no-ff` into `main`, only where a merge is allowed.
- **UI work runs Impeccable itself:** `/impeccable <command> <target>`, meaning the `impeccable` skill invoked with the Skill tool and `args: "<command> <target>"` (`power-tools-ui:impeccable` under the plugins). Never imitate a command from memory: invoking the skill runs its context setup, loads the command's reference and its craft rules, and uses its detector. Subagents that change UI invoke it the same way, and their brief says so.
- **Clean up** the worktrees you or your subagents created once the PR merges or closes. First check that `git -C <wt> status --porcelain` and `git -C <wt> rev-list --no-merges HEAD --not --remotes` both print nothing. Then unlink dependency-folder links (`cmd /c rmdir <wt>\node_modules` on Windows, `rm <link>` elsewhere), because deleting through a link wipes the checkout it points into. Then `git worktree remove <wt>` and `git worktree prune`. Keep the branch.

## UI gate

Every pipeline runs this gate once the PR is open (so its notes have a PR body to go in), when the PR touches UI (routes, pages, components, styles or UI copy) and the `impeccable` skill is installed (`power-tools-ui:impeccable` under the plugins). Skip it with a one-line note when `--no-ui` was given, when the PR has no UI surface, or when Impeccable isn't installed; in that last case the note says the gate needs the `power-tools-ui` plugin (or the installer's `--with ui`). The threshold N comes from the skill's `--score N` flag and defaults to 38, so 39/40 or better passes.

1. **Score gate.** List every UI surface the PR touches. For each one, invoke the `ui-critique-loop` skill (`power-tools-ui:ui-critique-loop` under the plugins) with `--score <N> <target>`. Its blinded assessors decide the score; never score it yourself. Hand the fixes to subagents, one per surface or file group, until each surface verifies above N, and re-run the affected end-to-end specs after each round. If `ui-critique-loop` isn't installed, run `/impeccable critique <target>` and fix its findings instead. If a surface still isn't above N when `ui-critique-loop` stops, don't start another run: put its score and remaining deductions in the PR body and the final report for the owner.
2. **UX and Design persona review.** Spawn two read-only reviewer subagents in parallel over the PR's UI surfaces:
   - **UX persona (senior UX researcher and interaction designer):** task completion and flow friction, information architecture, navigation and wayfinding, empty/loading/error states, forms and validation, permission and role differences, keyboard and screen-reader accessibility, responsive and mobile behaviour, and UX copy.
   - **Design persona (senior product and visual designer):** fit with the repo's design system (and `DESIGN.md` if present), visual hierarchy, typography, spacing and alignment, colour and contrast, consistency with neighbouring screens, motion, and polish.

   Each returns findings with severity, location and a concrete fix, using screenshots where browser tools are available. Hand the verified findings to implementation subagents (one writer per file). Each applies its findings through the Impeccable command that owns them (`/impeccable layout`, `clarify`, `typeset`, `adapt`, `harden`, `polish`, ...), run as `/impeccable <command> <target>`: the `impeccable` skill invoked with the Skill tool and `args: "<command> <target>"`, not from memory. Then re-run the affected tests, and if the fixes changed UI, re-run `ui-critique-loop` on the affected surfaces so the score holds. Commit and push.

**Don't stop at Impeccable's questions.** When a command would ask (critique's "what next" questions, a direction pick, any "Recommended" option), take the recommended option, or the one most consistent with the repo's product and design docs, and log the question and the pick in the PR body. Ask the owner only for a decision with no defensible default (legal, real money, anything that ships to production). Subagents get this rule in their brief.

**Review what the gate changed.** If the gate committed code, run `code-review` at `high` over those commits before the pipeline calls the PR done, and fix the findings.

Overdrive is not part of this gate. For an ambitious pass, use `/ui-finalize` (the owner picks the direction) or `/ux-mockup` (picks the recommended direction itself), both in the `power-tools-ui` plugin.
