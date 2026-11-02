# Hooks

A hook is a script Claude Code runs on an event, such as a tool call or the start of a session.
Each plugin registers the hooks of its own skills, from its own `hooks/hooks.json`, so installing
`power-tools` alone registers no `power-tools-projects` hook. The installer registers the same
hooks for the skills it installs. Every hook script fails open: if it errors, your prompt,
command or session start goes ahead as if the hook weren't there.

| Hook | Plugin | Event | What it does | Without it |
|---|---|---|---|---|
| git-guard | `power-tools` | `PreToolUse` (`Bash\|PowerShell`) | Denies git and delete commands that lose another session's work (list below), naming the safe alternative. | The rules are only advice in the skills. |
| git-guard ledger | `power-tools` | `PostToolUse` (`Edit\|Write\|MultiEdit\|NotebookEdit`) | Records the files this session wrote, so git-guard doesn't stop you over your own changes. | git-guard also stops on files you wrote. |
| git-guard approvals | `power-tools` | `UserPromptSubmit` | Records merges you approve for the opt-in merge gate: a first line that is only `approve merge #12`. | With the gate on, every `gh pr merge` is denied. |
| hook doctor | `power-tools` | `SessionStart` | Checks that every installed hook script runs (under the plugins, the `power-tools` ones). Silent unless one is broken, since a broken hook otherwise looks the same as one with nothing to do. | A broken hook goes unnoticed. |
| fleet-manager debounce | `power-tools` | `UserPromptSubmit`, `PreToolUse` (`Skill`) | Skips a `/fleet-manager` pass that ran under 10 minutes ago, or when nothing changed since a quiet pass (backoff 30 min → 4 h). | Every pass runs in full, so loops cost more. |
| usage-handoff | `power-tools` | `UserPromptSubmit`, `PostToolUse` (every tool except Read, Grep, Glob and the like, which run often and would each pay for a Node start) | Reads Claude usage from a cache shared by every session (re-read every 1 to 10 minutes). At 95% it tells the session, or the subagent, once per window to wrap up and fill in a handoff, creates the handoff file, and starts a background waker. After the reset the waker runs a hidden `claude -p` that messages open sessions (they resume in their own window) and reopens only closed ones, each in a window that closes when you exit it. Turn it off with `/usage-handoff off` or `USAGE_HANDOFF_HOOK=off`. | Sessions stop mid-task at the limit, unless `/loop /usage-handoff` is running. |
| request-inbox check | `power-tools` | `SessionStart` | Lists pending inbox requests in the new session's context. Silent in repos without an inbox. | Sessions see requests only when `/request-inbox` runs. |
| project resume | `power-tools-projects` | `SessionStart` | When a session starts in a project with `/new-project` stages left, prints one line naming the next step. | You resume with `/new-project resume`. |
| completion gates | `power-tools` | `Stop` (in the skills' own frontmatter) | Keep `implement-to-pr` and `finish-pr` working until they end with a `*-COMPLETE:` or `*-BLOCKED:` line. | Nothing to install: they come with the skills. |

**git-guard denies:**

- `--no-verify`, `commit -n` and `core.hooksPath` overrides
- force-push (a `--force-with-lease` push is fine, except to `main`)
- committing on `main` while other worktrees share the checkout
- `checkout`, `switch`, `stash`, `pull`, `reset --hard` and `clean` in a main checkout with another
  session's uncommitted files
- deleting a folder that holds a junction or symlink, such as a linked `node_modules`
- `gh pr merge` without your approval and green checks, when the opt-in merge gate is on

Switch a rule off for one repo with `/git-guard allow <rule>`. See the `git-guard` skill for the
rule names.

Impeccable's design-detector hook is **not** installed. It is opt-in per project: run
`/impeccable hooks on` in a repo, and Impeccable adds it to that repo's
`.claude/settings.local.json`. Without it, Impeccable asks for one manual detector run at the end
of a UI session.

## What the installer writes

The installer adds this to `~/.claude/settings.json`, with absolute paths (shown here for a
`~/.claude` install with `--all`; the project hook comes only with the `projects` group). The
plugins use the same commands with `${CLAUDE_PLUGIN_ROOT}`, which is each plugin's own folder;
see [power-tools](../plugins/power-tools/hooks/hooks.json) and
[power-tools-projects](../plugins/power-tools-projects/hooks/hooks.json). `power-tools-ui` has
no hooks.

<details><summary>The settings JSON</summary>

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node \"~/.claude/skills/fleet-manager/scripts/debounce.mjs\"", "timeout": 45, "statusMessage": "Checking /fleet-manager debounce" }] },
      { "hooks": [{ "type": "command", "command": "node \"~/.claude/skills/git-guard/scripts/git-guard.mjs\"", "timeout": 15 }] },
      { "hooks": [{ "type": "command", "command": "node \"~/.claude/skills/usage-handoff/scripts/usage.mjs\" --hook", "timeout": 15 }] }
    ],
    "PreToolUse": [
      { "matcher": "Skill", "hooks": [{ "type": "command", "command": "node \"~/.claude/skills/fleet-manager/scripts/debounce.mjs\"", "timeout": 45, "statusMessage": "Checking /fleet-manager debounce" }] },
      { "matcher": "Bash|PowerShell", "hooks": [{ "type": "command", "command": "node \"~/.claude/skills/git-guard/scripts/git-guard.mjs\"", "timeout": 15 }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "node \"~/.claude/skills/git-guard/scripts/git-guard.mjs\"", "timeout": 10 }] },
      { "matcher": "Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|Agent|Task|Skill|WebFetch|WebSearch|SendMessage|mcp__.*", "hooks": [{ "type": "command", "command": "node \"~/.claude/skills/usage-handoff/scripts/usage.mjs\" --hook", "timeout": 15 }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node \"~/.claude/skills/request-inbox/scripts/inbox.mjs\" --hook", "timeout": 15 }] },
      { "hooks": [{ "type": "command", "command": "node \"~/.claude/skills/project/scripts/projects.mjs\" --hook", "timeout": 10 }] },
      { "hooks": [{ "type": "command", "command": "node \"~/.claude/skills/update/scripts/doctor.mjs\" --hook", "timeout": 30 }] }
    ]
  }
}
```

</details>
