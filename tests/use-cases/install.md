# Use case: installing the power tools

Priya runs three Claude Code sessions on her team's repo and wants the fleet
skills on her laptop.

1. She clones `claude-power-tools` and runs `node scripts/install.mjs --dry-run`.
   It lists the core skills it would copy into `~/.claude/skills` (everything the
   `power-tools` plugin ships: the fleet, PR and delivery skills, git-guard and
   `/update`) and the hooks it would add to `~/.claude/settings.json`, and changes
   nothing. It ends with the groups it left out: `ui`, `projects` and `graphify`.
2. She runs `node scripts/install.mjs --link`. Each skill folder is linked, so a
   later `git pull` updates them. Her existing settings (a formatter hook and her
   permissions) stay as they were; the installer only appends the
   `/fleet-manager` debounce hooks (UserPromptSubmit and PreToolUse on `Skill`),
   the git-guard hooks (PreToolUse on `Bash|PowerShell`, PostToolUse on edits,
   UserPromptSubmit for merge approvals) and the request-inbox and hook-doctor
   SessionStart hooks, and saves a timestamped backup of the old `settings.json`
   first. It writes `~/.claude/claude-power-tools.json` recording the version, the
   commit, the mode, the skills and the groups she asked for (`core`), which
   `/update` reads later. `--skills` names no group, so it adds none; a manifest
   from before groups were recorded gets them from its skills.
3. She runs the installer again by accident. Nothing is duplicated: skills that
   already exist are skipped, and hooks already present are left alone.
4. Her teammate only wants the PR dashboard:
   `node scripts/install.mjs --skills pr-dashboard`. No hooks are added,
   because the dashboard doesn't need any.
5. If `settings.json` is not valid JSON, the installer stops with a clear error
   instead of overwriting it.
6. She also wants the UI skills: `--with ui` adds `ux-mockup`, `ui-critique-loop`,
   `ui-finalize` and `impeccable`. Impeccable's four subagents
   (`agents/impeccable-*.md`) are copied into `~/.claude/agents`, rewritten to
   point at the installed skill. If she already had an older Impeccable, the skill
   and its agents are both skipped, so the agents never point at a skill version
   they weren't written for; `--force` backs both up and replaces them. The backups
   go to `~/.claude/backups/claude-power-tools/<UTC>/`, not next to the live skill,
   so Claude Code never loads two copies of the same skill.
7. `--with projects` adds `/new-project`, `/project` and `/deploy`, with the
   project session-start hook. `--all` is core, ui and projects together, the same
   set as installing all three plugins. `--with` still takes single skill names
   too, such as `--with deploy`.
8. `graphify` isn't in any group but its own, not even `--all`, because its
   description claims every codebase question. She adds it with `--with graphify`.
   Its Python CLI (`graphifyy`) isn't on her PATH, so the installer prints
   `uv tool install graphifyy` (or the pipx form) instead of installing it. Her
   teammate's CLI is older than the skill, so theirs prints the upgrade command. A
   CLI newer than the skill is told to run `/update` for a newer bundle, in the same
   words the doctor uses. Nothing is installed with pip behind her back.
9. Months later she installs the `project` skill next to the request inbox she
   already has. Only the project hook is added; the inbox hook isn't duplicated.
10. Because her skills are linked (junctions on Windows), every hook runs its
    script through the link, not from the clone. git-guard still denies her
    force-push to `main`, and the project CLI still answers, so a linked install
    behaves exactly like a copied one.
11. Her clone was linked before 0.6, when every skill sat in `<clone>/skills/`. After
    she pulls, those folders have moved into `plugins/<plugin>/skills/`, so her links
    point at nothing (or at a folder holding only a `__pycache__`). The next
    `--link` installer run re-links every skill the manifest recorded, even ones she
    didn't name this time, to its new folder, and says so: `re-link 2 skill(s) to
    their new folders`. A dry run only reports it. A link to some other working copy
    is left alone unless she passes `--force`.
12. Only a `--link` run links. Her teammate runs the installer without `--link`
    (a copy install, which is also how a copy-mode `/update` runs it, from a
    temporary download it deletes afterwards). A selected skill whose link went
    stale is backed up and replaced by a real copy, even without `--force`, and
    `--force` turns a working link into a copy the same way, so the manifest's
    `copy` mode is what is on disk. A recorded skill she didn't select keeps its
    stale link, and the installer names it and says to re-link with `--link`.
13. 0.7.0 retired `ship-plan` (use `/implement-to-pr --review-plan --merge`).
    Priya's manifest still records it, so her next installer run removes her
    `ship-plan` link (the folder it pointed at is untouched), drops it from the
    manifest and prints `remove retired skill ship-plan (use
    /implement-to-pr --review-plan --merge)`. Her teammate's copied
    `ship-plan` folder isn't deleted: it moves to
    `~/.claude/backups/claude-power-tools/<UTC>/` like any replaced copy. A dry
    run only reports it, and a `ship-plan` folder the manifest doesn't record
    (her own skill of that name) is left alone.
