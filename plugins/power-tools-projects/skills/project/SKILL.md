---
name: project
description: "Remembers the owner's project folders and projects across sessions: list, add or forget folders, set the default, register a repo, show a project's /new-project stage. Trigger on '/project', 'where are my projects' or 'what stage is <project> at'. To start a new project use /new-project."
user-invocable: true
disable-model-invocation: false
argument-hint: "[list | roots | add-root <dir> | default <dir> | forget-root <dir> | add <dir> | status <name> | forget <name> | scan]"
---

# Projects

Keeps a small registry of the folders the owner keeps projects in ("roots") and of the projects themselves, including how far each one got through `/new-project`. Other skills use it too: `/new-project` asks where to create a project from the remembered roots, and `/deploy` reads a project's type and URLs from it.

`SKILL_DIR` below means this skill's base directory. Every command runs `node "<SKILL_DIR>/scripts/projects.mjs" <command>`; [scripts/projects.mjs](scripts/projects.mjs) documents them all. The registry is `projects.json` in `POWER_TOOLS_HOME` (default `~/.claude/power-tools`). Times in it are UTC.

## Commands

Parse `$ARGUMENTS`. With no arguments, do `list`.

- **`list`**: run `roots` and `list` and show both: the folders (default marked) and one line per project with its stage and next step. If there are no roots yet, ask with `AskUserQuestion` where the owner keeps projects. Offer the folder that holds the current repo and the home folder's `Projects` (or `projects`, `code`, `src`, `dev`, whichever exists) as options, then `add-root` the answer.
- **`roots`**: list the remembered folders.
- **`add-root <dir>`**: remember a folder (`--default` to make it the default, `--create` to make it first). Expand `~` and relative paths before calling the script.
- **`default <dir>`**: run `default-root <dir>`.
- **`forget-root <dir>`**: run `remove-root <dir>`. It forgets the folder and never deletes anything.
- **`add [dir]`**: register an existing project (default: the current repo's top folder, `git rev-parse --show-toplevel`). Detect its type with `node "<SKILL_DIR>/../new-project/scripts/scaffold.mjs" detect <dir>` and save what applies with `set` (`kind=app|web`, `github=<owner/name>` from `gh repo view --json nameWithOwner`). Set `stage` to the furthest stage its files show: `VISION.md` → `vision`, `docs/implementation-plan.md` → `docs`, a mockup under `docs/design/` → `mockup`, an app that builds → `app-ready`. When unsure, take the earlier stage.
- **`status [name]`**: run `get <name>` (default: the project that contains the current folder) and print its stage, its next step and its URLs.
- **`forget <name>`**: run `remove <name>`. It forgets the project and never deletes its files.
- **`scan`**: list git repos under the roots that aren't registered, and offer to `add` them (multi-select, at most 4 per question).

Opening a project: a session can't change its own working folder. Print the path, and offer `code <path>` if VS Code is on `PATH`, or tell the owner to start Claude Code there (`cd <path>` then `claude`).

## Hook

The `SessionStart` hook (`projects.mjs --hook`) prints one line when a session starts inside a registered project with `/new-project` stages left, naming the stage and the next step. It stays silent elsewhere and never blocks a session.
