# Use case: a fleet manager that doesn't waste ticks

Lee runs `/loop /fleet-manager` in a busy repo overnight.

1. Lee types `/fleet-manager` and it runs. Typing it again two minutes later is
   skipped with a reason ("ran under 10 min ago") and a hint to use `--force`.
2. `/fleet-manager --force`, `/fleet-manager ci` or `/fleet-manager 143` always
   run, because explicit arguments bypass the debounce. `once` alone does not.
3. At 02:00 the tick finds nothing to do and records `quiet`. The next checks
   back off: 30 minutes, then 60, then 2 h, never more than 4 h, so the loop
   costs almost nothing while the repo sleeps.
4. At 05:10 a teammate pushes to a PR. The next check sees that the work
   fingerprint (open PR heads, review and check states, main's CI, inbox file
   names) changed, runs the tick, and resets the backoff.
5. When a dynamic `/loop` calls the skill and the hook skips it, the denial
   tells Claude to schedule its next wakeup instead of running a tick.
