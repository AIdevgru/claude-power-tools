---
name: ticket-to-pr
description: "Take one Jira or GitHub ticket to a reviewed PR: track it, build in a fresh worktree with tests, run the UI gate, open and review the PR, move the ticket to In Review, then ask the owner to merge or hold. Trigger on '/ticket-to-pr <key>', 'act on <key>', or an 'act' pick in /ticket-triage."
user-invocable: true
disable-model-invocation: false
argument-hint: "<ticket key, e.g. ABC-12 or #42> [--no-ui] [--score N]"
---

# Ticket to PR

If the repo's `AGENTS.md` or `CLAUDE.md` describes how to act on a ticket, that is the source of truth; read it first. Argument: the ticket key (`ABC-12` for Jira, `#42` or `42` for a GitHub issue). If it's empty, ask once. `--no-ui` skips the UI gate, and `--score N` sets its threshold (default 38); the old single-dash `-score N` is still accepted until 0.7.0.

## Tracker settings

From the `## Power tools` section of the repo's `CLAUDE.md` or `AGENTS.md`:
- **Jira:** `jira-cloud-id`, `jira-project`, `jira-transitions` (for example `in-progress=21, in-review=31, done=41`; if missing, read them with `getTransitionsForJiraIssue`), and optionally `jira-assignee` (an accountId; default: the current user from `atlassianUserInfo`).
- **GitHub Issues:** status is tracked with the labels `in-progress` and `in-review` (create them if missing), and the PR body says `Closes #<n>`.
- `push:`, `pr-title:` (default `<key>: <type>(<scope>): <summary>`), `merge-method:` (default squash), `worktree-root:` (default `../<repo>-<key>`).

## Ground rules

Follow [reference/delivery-rules.md](reference/delivery-rules.md): isolation (new work, so a worktree off `origin/main`), tracking the ticket, subagents and their models, fixing findings, tests, the UI gate, green CI and the never-list. Merging happens only on the owner's explicit "merge" below. Pass the rules file's path to the build agent so it follows them too.

## Delegate the build

The build steps are long. Hand them to a background `general-purpose` Agent (no `isolation`, because it makes its own worktree off `origin/main`) and brief it fully: the ticket text, the repo's rules, the worktree path, the tracker settings, and what to return: the PR number, the worktree path, whether the change touches UI (and which surfaces), test counts before and after, review findings with how each was resolved, the CI state, and a merge-or-hold recommendation.

The agent must:
1. Move the ticket to In Progress and assign it (Jira transition, or the `in-progress` label plus `gh issue edit --add-assignee @me`).
2. Create the worktree off `origin/main` on a branch named `<type>/<key>-<slug>`. If the repo shares dependency folders between worktrees (for example a `node_modules` junction), set that up the repo's way.
3. Implement, following the repo's rules: tests (and use-case stories if the repo requires them), running the suite before changing tests and again after, plus typecheck, lint and the backend tests as relevant. Note the version bump if the repo uses semver labels.
4. Push and open the PR titled per the repo's format, with a body that links the ticket (and `Closes #<n>` for GitHub). Comment the PR link on the ticket. Keep the ticket In Progress.
5. Run `/code-review high` on the PR, fix every confirmed finding, push, and wait for CI: total checks > 0 and all green.

## Close the loop (this session, not the agent)

When the agent returns:

1. **UI gate.** If the change touches UI and the owner didn't pass `--no-ui`, run the UI gate in [reference/delivery-rules.md](reference/delivery-rules.md) here, in the agent's worktree (threshold from `--score N`, default 38). It needs its own reviewer and fix subagents, which is why this session runs it rather than the build agent. Wait for CI to go green again on the new head.
2. **Post the take** as a PR comment: changes, evidence, the UI score and your verdict on whether you'd ship the UI (or "not UI"), findings and their fixes, residual risk, recommendation. Then move the ticket to In Review (Jira transition plus a comment, or swap the `in-progress` label for `in-review`).
3. **Ask the owner.** Give the analysis in a few lines plus the PR link, then ask with `AskUserQuestion`: **merge** or **hold**.

- **merge:** re-check that CI is green on the current head, merge with the repo's method (`gh pr merge <n> --squash` by default), move the ticket to Done with a merge-SHA comment (GitHub closes it via `Closes #<n>`), then clean up the worktree as the delivery rules describe.
- **hold:** ask for the reason (or infer it from the owner's note), comment it on the ticket and the PR, and leave the ticket In Review and the worktree in place.

Never merge without the explicit "merge" choice.
