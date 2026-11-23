# The installer

`scripts/install.mjs` installs the skills into `~/.claude/skills`, so they get plain names like
`/fleet-manager`. Use it **or** the plugins, not both: with both, every hook runs twice.

```sh
node scripts/install.mjs --dry-run      # show what would change
node scripts/install.mjs --link         # link the core skills, so `git pull` updates them
node scripts/install.mjs --all --link   # core, UI and project skills
node scripts/install.mjs                # copy skills instead of linking them
```

What it does:

- Copies each skill into `~/.claude/skills`, or links it with `--link`.
- Copies Impeccable's subagents into `~/.claude/agents` when it installs Impeccable.
- Adds [the hooks](hooks.md) of the skills it installs to `~/.claude/settings.json`, after saving
  a timestamped backup. It never removes or rewrites your existing settings.
- Records what it installed in `~/.claude/claude-power-tools.json`, which `/update` reads.

Running it twice changes nothing. Afterwards, open `/hooks` once (or restart Claude Code) so
running sessions load the hooks.

## Groups

The skills come in the same groups as the three plugins, plus graphify on its own:

| Group | Same as plugin | Skills |
|---|---|---|
| `core` (default) | `power-tools` | all, fleet-manager, fleet-status, pr-dashboard, request-inbox, usage-handoff, show-model, show-email, show-usage, implement-to-pr, finish-pr, ticket-to-pr, ticket-triage, issues-to-plan, combine-prs, drain-pr-queue, git-guard, update |
| `ui` | `power-tools-ui` | ux-mockup, ui-critique-loop, ui-finalize, video, impeccable (and its 4 subagents) |
| `projects` | `power-tools-projects` | new-project, project, deploy |
| `graphify` | none | graphify |

A plain run installs `core`. `--with ui,projects,graphify` adds groups, `--all` installs `core`,
`ui` and `projects`, and `--skills a,b` installs exactly the skills you name. Skills that call a
skill from a group you left out say which plugin or group to add, and skip that step.

## Options

| Option | Effect |
|---|---|
| `--dry-run` | Show the plan and change nothing. |
| `--link` | Link each skill folder to this clone instead of copying it. |
| `--with a,b` | Also install these groups (`ui`, `projects`, `graphify`) or single skills. |
| `--all` | Install `core`, `ui` and `projects`. graphify still needs `--with graphify`. |
| `--skills a,b` | Install only these skills. |
| `--force` | Replace installed skills. The old copies move to `~/.claude/backups/claude-power-tools/<UTC>/`, outside `skills/`, so they don't load as duplicates. |
| `--no-hooks` | Leave `settings.json` alone: no hooks, no setting defaults. A `--no-remote-control` in the same run is still written. |
| `--no-remote-control` | Store `remoteControlAtStartup: false` instead of turning Remote Control on (see below). |
| `--target DIR` | Install into `DIR` instead of `~/.claude` (or `CLAUDE_CONFIG_DIR`). |

## Settings it turns on

Besides hooks, an install of the `core` group (a plain run, `--all`, or `/update` of an install
whose manifest recorded `core`) sets Claude Code settings the collection turns on by default, each only
when `settings.json` doesn't have it yet. `--skills pr-dashboard` alone gets only the skill. A value you set in `/config` or by hand always stays,
and `/update` runs the same installer, so it keeps your choice too.

| Setting | Default | Off switch |
|---|---|---|
| `remoteControlAtStartup` (Remote Control in every new session; `/config`: "Enable Remote Control for all sessions") | `true` | `--no-remote-control` stores `false`, or set it to `false` in `/config`. Its `default` there removes the key, so the next run sets it again. |

The status line's parts aren't Claude Code settings: `/show-model`, `/show-email` and
`/show-usage` switch them, and all start on.

## graphify is opt-in

The installer skips `graphify` unless you pass `--with graphify`, even with `--all`, because its
description claims any question about a codebase, so it competes with ordinary questions. No
plugin ships it; it lives in `extras/graphify/`. It also needs its Python CLI
(`uv tool install graphifyy` or `pipx install graphifyy`). The installer checks for the CLI and
prints that command, but never installs Python packages itself.

## Linked installs from 0.5 and earlier

Up to 0.5 every skill sat in `<clone>/skills/<name>`. From 0.6 they live in
`plugins/<plugin>/skills/<name>` (and graphify in `extras/graphify`), so after you pull, a
`--link` install's links point at folders that no longer exist. Every `--link` installer run
re-links each skill the manifest records, plus each skill you select, whose link is broken or
points elsewhere in this clone, and prints `re-link N skill(s) to their new folders`. It keeps the
set of skills you had, including the UI and project skills. A link to some other working copy is
left alone. A run without `--link` never links: it replaces a selected stale link with a copy
(backed up) and names the recorded ones it left, so rerun with `--link` to re-link those.

The 0.5 `/update` can't read the new layout, so for that one update run it by hand:

```sh
git -C <your clone> pull --ff-only
node <your clone>/scripts/install.mjs --link
```

From 0.6 on, `/update --force` pulls and re-links by itself. Copied (non-`--link`) installs aren't
affected by the move; to refresh them from 0.5, run `node scripts/install.mjs --force` with
`--all` or the groups you had, from a fresh clone.

## Retired skills

When a release retires a skill (0.7.0 retired `ship-plan`; use `/implement-to-pr --review-plan --merge`),
the next installer run or `/update --force` takes it out if the manifest records it: a linked
skill's link is removed, a copied one moves to `~/.claude/backups/claude-power-tools/<UTC>/`, and
it leaves the manifest. It prints `remove retired skill <name> (use /<replacement>)`. A folder of
that name the manifest doesn't record isn't touched.

## Updating

`/update` shows the installed and latest versions and what would change. `/update --force`
applies it: a plugin update, a fast-forward of a `--link` clone, or a fresh download for copied
skills. It keeps the skills the manifest recorded, and `--all` also adds skills that are new since
the last install, in the groups you installed (the manifest records them). It never adds a group,
so graphify stays opt-in. It ends with a check that every hook runs.
