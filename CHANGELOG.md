# Changelog

All notable changes to claude-power-tools. Versions follow [semver](https://semver.org/). The
version lives in `package.json` and in each `plugins/<plugin>/.claude-plugin/plugin.json`, which
`npm test` keeps equal.

## Unreleased

### Added

- **`/all "<message>"` messages every running agent, then closes this session.** It sends the
  message word for word to every row `ListAgents` shows and reports who got it. Then its
  `quit.mjs` walks up from its own process to this session's Claude process and ends only that one,
  3 seconds later. With no message, or when no message was delivered, the session stays open.
  It works through a linked install too: the script compares real paths to tell it was run directly.

### Fixed

- **usage-handoff resumes when a limit resets early.** It used to wait for the predicted reset
  time even when the window had already reset. While waiting, the waker now checks the shared
  reading, and the status line says `reset early, resuming`.
- **The status line no longer shows a bare weekday for next week's same day.** On a Monday, next
  Monday's reset shows its date (`Mon, Nov 9 1:59 PM EST`), not `Mon`.
- **Usage is read again as soon as you log in.** The shared reading now remembers which login it
  was taken under (a short hash of the token, never the token). After `/login`, a logout or a
  renewed token, the next hook call or status line refresh reads usage again instead of showing
  the old reading, or "no reading yet", for up to 10 minutes. When the reading failed, the status
  line now says why (`usage: not logged in ...`).
- **The hidden resume session no longer takes focus on Windows.** The waker runs without a console,
  so a program it started without hiding (finding `claude` with `where`) opened its own console
  window and took focus. So could anything the resume session ran (hooks, git, shells), because
  it had no console either. Every process usage-handoff starts now hides its window, and the
  resume session gets one hidden console that what it runs shares. On Windows the waker waits for
  that session to end (an attached child ends with its parent) and logs its exit code.

### Changed

- **The usage status line shows each window's own reset**: `5h 68% (resets 5:10 AM EST) · week 23%
  (resets Sun 4:00 PM EST)`, with 5h always first. Before, one reset time followed both windows, so it wasn't clear which
  one it belonged to.
- **Times shown to the owner are 12-hour with AM or PM** (`12:10 AM EST`), in usage-handoff, the
  status line and the fleet-manager and fleet-status reports. Logs and handoff files keep UTC.

## 0.7.0 (2026-11-02)

Upgrading: run `/update --force` (or the installer) once; it removes the retired `ship-plan` skill.

### Removed

- **`ship-plan`**, deprecated in 0.6.0. Use `/implement-to-pr --review-plan --merge` (omit
  `--merge` for the old `--no-merge`). The plugin no longer ships it, and on installer installs the
  next installer run or `/update --force` removes it if the manifest records it: a linked skill's
  link is removed, a copied one moves to `<target>/backups/claude-power-tools/<UTC>/`, and it
  leaves `claude-power-tools.json`.

### Added

- **`usage-handoff`**, with a hook that is on by default (`UserPromptSubmit`, `PostToolUse`).
  When a Claude usage window reaches 95% (`--threshold N` changes it), each session is told once
  to have its subagents report, save its work and fill in a handoff in
  `~/.claude/usage-handoff/handoffs/`, which the hook creates with the session id, folder and
  branch. Subagents are told to stop at a safe point. A background waker restarts the work after
  the reset: open sessions are messaged, closed ones reopen with `claude --resume <id>`.
  `/usage-handoff off` (or `USAGE_HANDOFF_HOOK=off`) turns the hook off; `/loop /usage-handoff`
  adds a watcher session that also messages sessions without the hook.

- **`/usage-handoff rehearse`** plays the whole handoff-and-resume cycle in a scratch folder with
  made-up usage in about ten seconds, printing `ok` or `FAIL` per step and any leftovers in the
  real state folder. `reset` and `finish-resume` now remove old resume claims.
- **`/usage-handoff statusline`** puts usage in Claude Code's status line
  (`5h 64% · week 49% · resets 00:10 EST`), read from the hooks' shared reading with no extra
  call to the usage endpoint.

### Changed

- **The usage-handoff hook skips Read, Grep, Glob and other quick lookups** on `PostToolUse`. Each
  hook call costs a Node start (about 140 ms on Windows) and those tools run most often. A linked
  install keeps its old hook entry: add the new `matcher` from `docs/hooks.md` to settings.json
  for the speedup.

### Fixed

- **usage-handoff resumes without extra windows.** The waker used to open a visible resumer
  session, and a hook call could start a second waker that opened another one; both stayed open.
  Now the resumer is a hidden `claude -p` (output in `~/.claude/usage-handoff/resumer.log`), it
  starts only when a handoff is pending, a waker never re-takes a waker's claim, and the hook
  restarts a waker only while waiting for the reset. Open sessions resume in their own window;
  a closed session reopens in a window that closes when you exit it. The waker starts `claude` by
  its full path (`USAGE_HANDOFF_CLAUDE` overrides), because `cmd.exe` can miss it in a long PATH.

- **usage-handoff shows times in your time zone.** The note, the handoff's `Resets:` line
  (`2026-11-02T05:10:00Z (00:10 EST)`) and `check`/`status` (`resumeAtLocal`) give local time,
  with the date when the reset isn't today. Sessions are told never to quote UTC.

## 0.6.0 (2026-10-31)

Upgrading from 0.5? See "Upgrading from 0.5" in the README. The old `/update` can't follow the
new folder layout, so it takes one manual step.

### Breaking

- **The single `claude-power-tools` plugin is now three plugins** in the `aidevgru` marketplace.
  Each registers only its own hooks.

  | Plugin | Contents | Skill names |
  |---|---|---|
  | `power-tools` | fleet, PR and delivery skills, git-guard, `/update` | `/power-tools:<skill>` |
  | `power-tools-ui` | ux-mockup, ui-critique-loop, ui-finalize, Impeccable and its agents | `/power-tools-ui:<skill>` |
  | `power-tools-projects` | new-project, project, deploy | `/power-tools-projects:<skill>` |

- **The marketplace renames `claude-power-tools` to `power-tools`.** This moves only the enabled
  setting, not the install. The 0.6 `/update` installs `power-tools` itself and lists the other
  two plugins.
- **graphify is no longer in any plugin.** It lives in `extras/graphify` and is installer-only
  (`--with graphify`).
- **The installer's default is now the core group.** Add groups with `--with ui,projects,graphify`,
  or use `--all` for core, ui and projects. `--skills` and `--with <skill>` still work.
- **Skills moved** from `skills/<name>` to `plugins/<plugin>/skills/<name>`. The installer and
  `/update` re-link every recorded skill of a `--link` install and report it.


### Added

- `LICENSE` (Apache-2.0) and `NOTICE`. The bundled Impeccable and graphify keep their own
  licenses (see `THIRD_PARTY.md`).
- `CONTRIBUTING.md`, this changelog, and the release-readiness plan in
  `docs/plans/2026-10-31-release-readiness.md`.
- Trigger evals for `ticket-to-pr`, `ticket-triage` and `ui-finalize`. Evals now live in each
  plugin, and `npm run eval` runs `claude plugin eval` once per plugin.
- `scripts/layout.mjs`: the one map of which skill lives in which plugin. The installer, the
  scripts and the tests all read it.
- README: "Start here" and "Top commands" with examples. `npm test` checks that every command it
  shows names a real skill and switch.

### Changed

- **`ship-plan` is folded into `implement-to-pr`.**
  - `/implement-to-pr <plan> --review-plan --merge` does what `/ship-plan` did. `--review-plan`
    reviews and improves the plan against the code, then writes an implementation plan to
    `plans-dir`.
  - `/ship-plan` still works as a deprecated shim that forwards there. It will be removed in 0.7.0.
- **Merging is opt-in in every remaining pipeline.**
  - `implement-to-pr` merges only with `--merge`.
  - `finish-pr` never merges.
  - `ticket-to-pr` asks you.

  The deprecated `/ship-plan` shim keeps its old behavior and still merges unless you pass
  `--no-merge`.
- **One UI gate, defined once in `delivery-rules.md`.** It runs when a PR touches UI:
  `ui-critique-loop --score N` on each touched surface, then the UX and Design persona review.
  - `implement-to-pr`, `finish-pr` and `ticket-to-pr` all use it, and `--no-ui` skips it.
  - Overdrive is no longer part of any automatic pipeline. It stays in `ui-finalize`, where you
    pick the direction, and in `ux-mockup`, which picks it itself.
- **Ticket tracking moves into the shared delivery rules.** With a configured tracker, every
  pipeline moves the ticket through In Progress, In Review and Done.
- **Flags use double dashes:** `--score`, `--rating`, `--no-overdrive`. The single-dash forms
  still work until 0.7.0.
- **`ui-critique-loop` and `ui-finalize` are rewritten in plain language with the same rules.**
  You can now invoke them directly (`user-invocable`), and they have argument hints.
- **`fleet-status` reads each session's status file first.** It messages only sessions whose
  line is missing or over 15 minutes old, so busy sessions aren't interrupted.
- **`fleet-manager` loads less by default.** Its auto-mode threat levels and debounce details
  moved to `reference/auto-mode.md` and `reference/debounce.md`.
- **Every first-party skill description is 300 characters or less**, so the skill listing costs
  less context in every session. `npm test` enforces the limit.
- The README is now a first-run guide. Reference material moved to `docs/hooks.md`,
  `docs/installer.md` and `docs/development.md`.

### Fixed

- `/update` reads the version from `package.json`, and every plugin's `plugin.json` must match
  it (`npm test` checks).
- `/update` offers new skills only in the installer groups an install has, which the manifest now
  records (older manifests get them from their skills). A core install isn't offered the ui,
  projects or graphify skills, and `/update --all` never adds graphify unless it is installed.
- A plugin `/update` only updates our plugins installed at user scope or in the current project.
  It installs nothing except `power-tools` when migrating from the 0.5 `claude-power-tools`
  record, and only then names the plugins that aren't installed.
- Only a `--link` installer run re-links stale skill links. A copy run (including a copy-mode
  `/update` from its temporary download) replaces a selected stale link with a copy, backed up,
  so the manifest's mode matches what is on disk.
- `npm run eval` starts `claude` without a shell where it can, so arguments with spaces survive
  on Windows.
- `/update` and the hook doctor no longer mistake a linked clone's `plugins/` folder for a plugin
  install.
- The git-guard tests no longer depend on the checkout that runs them. A `main` checkout with
  other worktrees made one case fail with `commit-on-main`.

## 0.5.0 (2026-10-28)

### Added

- Hook doctor. Every hook script answers `--self-test`, and a `SessionStart` doctor (also run by
  `/update`) names any hook that is installed but not running.
- git-guard merge gate (opt-in). `gh pr merge` runs only after the owner writes
  `approve merge #N` as the first line of a message and every check on #N is green.
  - Each approval is bound to the repo and to the PR's head commit.
  - `--admin` is always refused.
- `/pr-dashboard` messages only sessions whose status line is over 15 minutes old. Delivery
  pipelines rewrite their status line when their PR changes.
- CI runs `npm test`, the vendor check and the shared-file check on Linux and Windows.
- `docs/windows.md` covers the PowerShell 5.1 traps.

### Fixed

- The git-guard ledger keeps real paths, so Windows 8.3 short names match git's long names.
- Fixes from the code review of the merge gate, the doctor and the dashboard.

## 0.4.1 (2026-10-27)

### Changed

- Bundles graphify 0.9.97.

## 0.4.0 (2026-10-27)

### Added

- The git-guard hook blocks:
  - `--no-verify` and force-push
  - commits on a shared `main`
  - checkout, stash or pull over another session's dirty files
  - deletes through junctions
- `/project`: a registry of project folders and stages, with a session-start resume hint.
- `/new-project`: empty folder to a running app (Tauri 2 or web), with an optional Docker and
  Postgres setup, VISION.md, docs, a mockup and `/implement-to-pr`.
- `/deploy`: a splash page on GitHub Pages and the app via GitHub Actions.
- `/update`: a dry run by default; `--force` applies.
- Shared `reference/delivery-rules.md` for the delivery pipelines.
- Trigger evals (`npm run eval`).

### Fixed

- Scripts detect a direct run by its real path. Before this, every hook did nothing in a `--link`
  install.

## 0.3.0 (2026-10-26)

### Changed

- The UI skills run every design step as a real `/impeccable <command> <target>` Skill call.

## 0.2.0 (2026-10-26)

### Added

- Bundles Impeccable 4.8.0 and graphify 0.9.96 unmodified. They are pinned by commit and sha256
  in `vendor.lock.json`.

## 0.1.0 (2026-10-26)

### Added

- The first fifteen skills:
  - fleet-manager, fleet-status, pr-dashboard, request-inbox
  - ship-plan, implement-to-pr, finish-pr, combine-prs, drain-pr-queue
  - issues-to-plan, ticket-triage, ticket-to-pr
  - ux-mockup, ui-critique-loop, ui-finalize
- Their hooks, an installer and a plugin manifest.
