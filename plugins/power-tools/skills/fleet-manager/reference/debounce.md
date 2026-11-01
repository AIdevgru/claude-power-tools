# Debounce hook

Reference for how the `/fleet-manager` debounce hook decides whether a tick runs. Read it when a `/fleet-manager` call comes back denied and you need more than `SKILL.md`'s one rule, or when debugging the hook. `SKILL_DIR` is the fleet-manager skill's base directory.

The installer adds `scripts/debounce.mjs` to `~/.claude/settings.json` on `UserPromptSubmit` (a typed or cron-fired `/fleet-manager`) and on `PreToolUse` for `Skill` (`/fleet-manager` started by a dynamic `/loop`). It skips the tick when:

- the manager ran less than 10 minutes ago, or
- the last recorded outcome was `quiet` or `done` and the work fingerprint hasn't changed. The fingerprint covers open PR heads, their review and check states, `main`'s latest CI run, and the inbox file names.

After a quiet or done tick, the hook waits 30 minutes before its first check. Each check that finds nothing new doubles the wait, up to 4 hours. Any change resets the backoff and lets the tick run. Peer messages wake the session by themselves and aren't part of the fingerprint.

A skipped tick doesn't run at all. A skipped `Skill` call comes back denied, with the reason and a suggested wakeup delay. When that happens, don't run a tick: schedule the next wakeup as the reason says and end the turn. Any argument other than `once` (`--force`, a focus, `--help` or `--deploy`) bypasses the debounce. `node <SKILL_DIR>/scripts/debounce.mjs status` shows the state; `reset` clears it. The hook fails open: if it errors, or isn't installed, the tick runs.
