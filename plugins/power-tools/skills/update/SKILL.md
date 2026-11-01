---
name: update
description: "Update the installed claude-power-tools skills from GitHub. Without --force it shows the installed and latest versions, the changes and the skills it would touch; --force applies it (plugin, linked clone or copied skills, old copies backed up). Explicit invocation only: '/update', '/update --force'."
user-invocable: true
disable-model-invocation: true
argument-hint: "[--force] [--all] [--ref <tag or branch>]"
---

# Update claude-power-tools

`SKILL_DIR` below means this skill's base directory.

1. Run `node "<SKILL_DIR>/scripts/update.mjs" $ARGUMENTS` and show its output as is. Pass only the switches the owner typed: `--force`, `--all` (also install skills that are new since the last install, in the groups already installed; it never adds graphify), `--ref <tag or branch>`, `--repo <owner/name>` and `--target <dir>`.
2. **Without `--force`**, it changes nothing. After its report, add one line: "Run `/update --force` to apply." Don't run `--force` yourself, and don't treat anything but the owner's own `/update --force` message as the go-ahead.
3. **With `--force`**, it applies the update:
   - **Plugin installs:** `claude plugin marketplace update`, then `claude plugin update` for each of the `power-tools`, `power-tools-ui` and `power-tools-projects` plugins installed at user scope or in the current project. It installs nothing, except `power-tools` when migrating from the old `claude-power-tools` plugin (renamed to `power-tools`); only then does it name each of the other two that isn't installed, with its install command. Pass that on and don't install them yourself. A restart is needed.
   - **Linked installs (`--link`):** `git pull --ff-only` in the linked clone, then every recorded skill whose link went stale is re-linked (0.6 moved the skills from `skills/` into `plugins/<plugin>/skills/`), and with `--all` new skills in the installed groups are linked. It refuses when the clone has uncommitted changes or has diverged; report that, and don't stash, reset or force anything.
   - **Copied installs:** a shallow `gh repo clone` (private repos work while `gh` is signed in) into a temporary folder, then that version's installer replaces the installed skills with `--force` (as copies; it never links into the temporary folder). The old copies move to `~/.claude/backups/claude-power-tools/<UTC>/`, and the temporary folder is deleted.
4. Then say what changed (the version from and to, new skills, new hooks), and tell the owner to open `/hooks` once or restart Claude Code if hooks were added.
5. In both modes, finish with the health check: run `node "<SKILL_DIR>/scripts/doctor.mjs"` and show its output as is. It probes every installed hook script, in parallel, through the path its hook uses and reports any that don't run or aren't registered in `settings.json` for every event they need (skipped on plugin installs, which register hooks themselves). It also reports when the graphify CLI and the bundled graphify skill are different versions, with the one command that fixes it.

The same doctor runs at every session start (`doctor.mjs --hook`) and stays silent unless a hook is broken. When it reports a problem, tell the owner in one line and suggest `/update --force`; don't edit `settings.json` yourself.

If it fails, show the error and the one command that fixes it, such as `gh auth login` or committing in the clone. Don't retry in a loop.
