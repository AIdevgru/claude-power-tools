---
name: show-model
description: "Show or hide the session's model in the usage-handoff status line (on by default). '/show-model' switches it; '/show-model on' or '/show-model off' sets it. Explicit invocation only."
user-invocable: true
disable-model-invocation: true
argument-hint: "[on | off]"
allowed-tools: Bash
---

# Show the session's model in the status line

`SKILL_DIR` below means this skill's base directory. The status line comes from the usage-handoff skill next to it: `<SKILL_DIR>/../usage-handoff/scripts/usage.mjs` (call it `USAGE`).

1. Take the argument: `on` or `off` as given, `toggle` when there is none. Anything else: print the argument hint and stop.
2. If `USAGE` doesn't exist, usage-handoff isn't installed here. Say that it draws the status line, and stop.
3. Run `node "USAGE" show model <value>` and print its answer as is. It says whether the part is now on or off, and whether the status line is set up yet.

The setting lives in `~/.claude/usage-handoff/config.json` and covers every session on this machine. The status line picks it up at its next refresh. With the model off, the line starts with the account.
