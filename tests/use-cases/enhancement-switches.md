# Use case: every enhancement starts on and has a switch

Lee installs claude-power-tools with the installer and has put usage-handoff in the status line
with `/usage-handoff statusline`. Lee wants everything the collection adds turned on from the
start, and wants to turn off any piece without editing JSON by hand.

## Remote Control in every session

1. Lee runs `node scripts/install.mjs --link`. Besides the skills and hooks, the installer sets
   `remoteControlAtStartup: true` in `~/.claude/settings.json`. This is the same switch as
   `/config`'s "Enable Remote Control for all sessions". The log says so, and that
   `--no-remote-control` turns it off. Every new session now starts with Remote Control, as if
   Lee had typed `/rc`.
2. Lee runs the installer again, or `/update --force` does. The setting is already there, so
   nothing changes and `settings.json` stays byte for byte the same.
3. Lee's teammate Sam doesn't want sessions reachable from claude.ai and installs with
   `--no-remote-control`. The installer stores `remoteControlAtStartup: false`, and later runs and
   updates keep it. If Sam had already installed and gotten `true`, the flag flips it to `false`.
4. Lee turns it off in `/config` instead, which writes `false`. The next install or update sees a
   value there and leaves it alone. Picking `default` in `/config` removes the key, so the next run
   turns it back on.
5. The default comes with the core group, as the main plugin's enhancement. A teammate who runs
   `--skills pr-dashboard` gets only the dashboard, and no `settings.json`. `/update` reruns the
   installer with `--skills`, but Lee's manifest records the `core` group, so the default still
   applies there. Only a group the manifest recorded counts: an older manifest that lists just
   `pr-dashboard` isn't taken for a core install. An explicit `--no-remote-control` is written in
   either case.
6. `--no-hooks` still means hands off `settings.json`: no hooks and no setting defaults. A
   `--no-remote-control` in the same run is still written, so a later `/update` can't turn Remote
   Control on against Sam's wishes. A dry run
   shows the setting it would write and writes nothing.
7. The default sits in one table, `SETTING_DEFAULTS` in `scripts/install.mjs`, so the next
   setting the collection turns on is one more row.

## The status line's parts

1. Lee's status line reads
   `Opus 5.5 · lee@example.com (+1) · 5h 64% (resets 12:10 AM EST) · week 49% (resets ...)`.
   All three parts start on: the model, the account and the usage.
2. Lee is about to share the screen, so Lee types `/show-email`. With no argument it flips the
   part: `show-email: off (the logged-in account)`. The next refresh reads
   `Opus 5.5 · 5h 64% (resets ...) · week 49% (resets ...)`. The `(+1)` count of other accounts goes
   with the email, since it's about accounts too.
3. After the call, `/show-email on` brings it back. `on` and `off` set the part, whatever it was.
4. `/show-model off` drops the model, and the line starts with the account.
   `/show-usage off` drops the percentages, the resets, an old reading's age and a failed
   reading's error. If the fleet is handing off at the limit, the line still says
   `handing off, back 4:00 PM EST`, even with no reading, because that's the fleet stopping, not a
   number.
5. With every part off the line is empty, and the command says so.
6. The switches are stored in `~/.claude/usage-handoff/config.json` under `show`, next to the hook
   switch. They cover every session on the machine, and each status line picks them up at its next
   refresh.
7. Sam hasn't set up the status line yet (in `settings.json` or `settings.local.json`). `/show-usage off` still stores the choice and adds
   `The status line isn't set up yet: /usage-handoff statusline shows how.`
8. The three commands start only when typed (`disable-model-invocation`), so Claude never switches
   a part on its own. Each one runs usage-handoff's script next to it
   (`usage.mjs show <part> on|off|toggle`). If usage-handoff isn't installed, the command says that
   usage-handoff draws the status line.
