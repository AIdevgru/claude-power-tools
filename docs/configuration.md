# Per-repo configuration

The skills work without configuration: they read the repo's own `CLAUDE.md` and `AGENTS.md`
and follow them, and they use GitHub (`gh`) for PRs and CI. Settings that differ per repo
go in a `## Power tools` section of the repo's `CLAUDE.md` or `AGENTS.md`. Every key is
optional. Anything the repo's own instructions say elsewhere wins over these keys.

```markdown
## Power tools

- tracker: jira                       # jira | github | none (default: github if gh works)
- jira-site: https://example.atlassian.net
- jira-cloud-id: 00000000-0000-0000-0000-000000000000
- jira-project: ABC
- jira-transitions: in-progress=21, in-review=31, done=41
- jira-assignee: <accountId>          # default: the signed-in user
- triaged-label: triaged
- push: GH_TOKEN=$(gh auth token --user my-login) git push   # default: git push
- pr-title: "<key>: <type>(<scope>): <summary> [<session>]"
- merge-method: squash                # squash | merge | rebase
- plans-dir: docs/plans/
- worktree-root: ../<repo>-<name>
- merge-deploys: yes                  # a merge to main deploys; fleet-manager says so in its reports
```

## Which skill reads what

| Key | Read by |
|---|---|
| `tracker`, `jira-*`, `triaged-label` | ticket-triage, ticket-to-pr, implement-to-pr, finish-pr, fleet-status |
| `push` | implement-to-pr, finish-pr, combine-prs, ticket-to-pr |
| `pr-title`, `merge-method` | implement-to-pr, ticket-to-pr, drain-pr-queue |
| `plans-dir` | implement-to-pr (`--review-plan`), issues-to-plan, ux-mockup |
| `worktree-root` | every skill that creates a worktree |
| `merge-deploys` | fleet-manager, drain-pr-queue |

## Environment variables (scripts)

| Variable | Script | Default |
|---|---|---|
| `FLEET_MANAGER_REPO` | fleet-manager debounce | `gh repo view` in the project dir |
| `FLEET_MANAGER_INBOX` | fleet-manager debounce | the request inbox of the main checkout |
| `FLEET_MANAGER_HOME` | fleet-manager ledger and debounce state | `~/.claude/fleet-manager/<owner>-<repo>/` |
| `CLAUDE_INBOX_DIR` | request-inbox | `<main checkout>/.claude-inbox`, else `.ForClaude` |
| `USAGE_HANDOFF_HOOK` | usage-handoff hook: `off` turns it off for that environment (`/usage-handoff off` does it for every session) | on |
| `USAGE_HANDOFF_CLAUDE` | usage-handoff: the `claude` executable the waker starts | found with `where`/`which`, then the usual install folders |
| `USAGE_HANDOFF_HOME` | usage-handoff (state, `handoffs/`, `waker.log`) | `~/.claude/usage-handoff` |
| `USAGE_HANDOFF_CMD` | usage-handoff: a command that prints usage JSON instead of asking Anthropic's usage endpoint | — |
| `PR_DASHBOARD_HOME` | pr-dashboard, fleet-status (session status lines in `status/`) | `~/.claude/pr-dashboard` |
| `PR_DASHBOARD_CI_WORKFLOW` | pr-dashboard | first of `ci-release.yml`, `ci.yml`, `ci.yaml`, `test.yml`, `tests.yml`, `build.yml` |
| `PR_DASHBOARD_MODEL` | pr-dashboard | `claude-haiku-5-5` |
| `PR_DASHBOARD_INBOX` | pr-dashboard | `.claude-inbox`, else `.ForClaude` |
| `PR_DASHBOARD_CLAUDE` | pr-dashboard | `claude` on `PATH` |
| `GIT_GUARD_HOME` | git-guard (session ledgers and the global `config.json`) | `~/.claude/git-guard` |
| `POWER_TOOLS_HOME` | project, new-project, deploy (`projects.json`) | `~/.claude/power-tools` |

## git-guard rules

Every git-guard rule except `merge-gate` is on by default. To switch one off for a repo, run
`/git-guard allow <rule>`, or write `<main checkout>/.claude/git-guard.json` yourself:

```json
{ "allow": ["commit-on-main"] }
```

The same shape in `<GIT_GUARD_HOME>/config.json` switches rules off for every repo. The rules
are `no-verify`, `force-push`, `commit-on-main`, `dirty-main-checkout`, `junction-delete` and
`merge-gate`; see the `git-guard` skill for what each one blocks.

`merge-gate` is opt-in. Switch it on with `/git-guard enable merge-gate`, or with an `enable` list
in either file:

```json
{ "enable": ["merge-gate"] }
```

With it on, Claude's `gh pr merge <N>` runs only after you start a message with a line that is only
`approve merge #N`, and every check on #N is green. The approval holds for that repo and for the
PR's head commit when you approved it; a new commit needs a new approval. Once you enable the gate
in `config.json`, a repo's own file can't switch it off. To let those merges through without a permission prompt,
add `"Bash(gh pr merge:*)"` to `permissions.allow` in `~/.claude/settings.json`. The gate keeps
that rule safe.
