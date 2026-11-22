# Use case: one look at every PR

Ana has eight open PRs across four Claude sessions and a CI queue that runs one
job at a time.

1. She types `/pr-dashboard`. The skill asks every peer session for a one-line
   status, written to a status file under `~/.claude/pr-dashboard/status/`.
2. A script collects the facts (PRs in merge order, CI shards, queue position
   and ETA, combined-PR membership, request-inbox claims), and a headless
   Claude only fills a fixed template: a one-line summary, short PR labels,
   notes and a "Needs you" list. Any number the model invents is rejected.
3. Ana sees one table: `main` is red on two shards, #144 is next in the queue
   with an ETA, #139 conflicts, and one session says CI is running when GitHub
   shows it queued.
4. `/pr-dashboard line` gives her the one-line version for a status message.
5. Her pipelines rewrite their status lines whenever their PR changes. When Ana
   runs `/pr-dashboard` again ten minutes later, `status-dir --recent 15` lists
   the sessions whose lines are under 15 minutes old. Only the others are
   messaged, so a busy session isn't interrupted to repeat what it already
   wrote. With `--fresh-within 900`, those current lines count as replies at
   once, and the dashboard waits only for the sessions it asked.
