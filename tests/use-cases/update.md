# Use case: updating the power tools

Priya installed the power tools a month ago and hears a new version is out.

1. She types `/update`. It reads `~/.claude/claude-power-tools.json`, sees her
   skills are linked to her clone, fetches, and lists the new commits and the
   version she'd move to. It changes nothing and says to run `/update --force`.
2. She runs `/update --force`. Her clone fast-forwards, so every linked skill is
   current at once. A skill that is new in this version is listed but not
   installed, because she only asked to update what she has. Only skills new in
   the groups she installed count: her install is `core`, so a new UI skill and
   graphify are not offered. The manifest records her groups; one from before
   that is read from her skills.
3. She runs `/update --force --all`, and the new core skill is linked too, with
   its hooks added to `settings.json`. The new UI skill and graphify still aren't
   installed: `--all` never adds a group, so graphify stays opt-in.
4. Her clone has an uncommitted experiment in it. `/update --force` refuses and
   says to commit or stash it there first; it never stashes or resets for her.
5. Her teammate copied the skills instead of linking them. Their `/update`
   downloads the latest release with `gh repo clone` into a temporary folder,
   shows the change list, and with `--force` reinstalls their skills from it,
   moving the old copies to `~/.claude/backups/claude-power-tools/<UTC>/`.
6. Someone on the plugin install gets the `claude plugin` commands to run (the
   marketplace update, then an update for each of our plugins they have at user
   scope or in the project they run it in), and `--force` runs them. A plugin
   installed only in another project, or a managed one, isn't touched, and
   `/update` never installs a plugin they didn't have. The one exception is the
   move to 0.6, when the skills started shipping as three plugins. The
   marketplace renames the old `claude-power-tools` plugin to `power-tools`, which
   moves its enabled setting but not its install record, so `claude plugin update
   power-tools` would say it isn't installed; when the old record is there,
   `/update` installs `power-tools` instead. Only then does it name each of
   `power-tools-ui` and `power-tools-projects` that isn't installed, with its
   install command, and leave installing them to the owner. Later updates don't
   repeat that list.
7. Priya's clone is still on 0.5, with every skill in `<clone>/skills/`. 0.6 moved
   them into `plugins/<plugin>/skills/` and `extras/`. The 0.6 updater pulls her
   clone, then re-links every skill her manifest recorded to its new folder, so
   she keeps all the skills she had. The version line reads the old root plugin
   manifest for 0.5 and `package.json` from 0.6 on (`0.5.0 → 0.6.0`). (The 0.5
   updater can't read the new layout, so the first time she runs
   `node scripts/install.mjs --link` in her clone after pulling; that re-links
   the same way.) A linked install that runs `/update` from its clone's real path
   is still a linked install, even though that path now has a `plugins/` folder in
   it; only Claude Code's plugin cache means a plugin install.
8. Every `/update` ends with the doctor. It runs each installed hook script with
   `--self-test` through the path its hook uses, so a linked install is probed
   through its links, all at once so the check costs one probe's time. It
   reports "All 4 hooks respond", or names each hook that doesn't run, or that
   `settings.json` doesn't register for every event it needs (git-guard
   registered for PreToolUse but not UserPromptSubmit records no approvals). On
   a plugin install, where the plugin registers the hooks, only the probes run,
   and each plugin's doctor sees only its own plugin's hooks.
9. Priya's link broke after she moved her clone. The next session starts with
   one line from the doctor's SessionStart hook naming the hooks that are doing
   nothing. When everything works, the hook says nothing.
10. Priya upgraded the graphify CLI past the bundled skill, so graphify warns on
   every call. The doctor names both versions and tells her to run `/update`
   for a newer bundle (or, if none exists yet, the maintainer's vendor command). An older CLI gets the `uv tool upgrade graphifyy` line instead.
