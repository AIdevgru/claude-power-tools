# Use case: everyone stops at the limit, one session uses up the rest, everyone carries on at the reset

Lee runs three Claude Code sessions on one Max plan: `api` (on `feat/billing`), `web` (on
`feat/cart`) and `docs`. The usage-handoff hook is on, as it is by default.

## The limit

1. At 96% of the 5-hour window, the hook adds its note to `api` first, so `api` coordinates this
   limit.
   - The note has the usual steps: stop starting work, gather subagents, WIP-commit and fill in the
     handoff.
   - It has three more for the coordinator:
     - Once its handoff is written, run `usage.mjs await-handoffs --session-id <id>`.
     - Schedule the restart job it prints.
     - If its role is `finish`, keep working.
2. `web` hears the note on its next tool call and writes its handoff. `docs` was idle, so it has
   nothing to hand off and gets no note.
3. `api` writes its handoff and runs `await-handoffs`. It waits, without using usage, until `web`'s
   handoff has its session name and Next steps (at most 9 minutes).
   - A session that closed (or ran out mid-turn) can't write any more, so nobody waits for it.
4. Every handoff is in. `await-handoffs` answers `role: finish` and a restart job. The job is a
   one-time cron a minute after the reset, never on :00 or :30, in local time.
   - `api` schedules the job with CronCreate (recurring false) and its prompt word for word.
   - Then it records the job: `usage.mjs job --id 7f3a --session-id <id>`. The record keeps the
     account that hit the limit: `lee@example.com`.

## Not leaving money on the table

1. `api` is the finisher, so it carries on with its own Next steps, keeping its handoff current.
2. Its hook stays quiet at 96–98%, for its subagents too: the finisher's line is `--finish-at`,
   99% by default.
3. At 99% the hook tells `api` once: stop, update the handoff, check with CronList that the job is
   still there, and end the turn.
   - Only one session finishes per limit. A second `await-handoffs` gets `wait`.
   - With `--finish-at 95` (or anything at or below the threshold), nobody finishes.

## The reset

1. Usage re-reads every 30 seconds above the threshold, so the finisher stops close to its line.
2. At the reset, `api`'s job runs `/usage-handoff continue --session-id <id> --round <round>`.
   - `continue` claims the restart, the same claim the background waker uses, so only one of them
     restarts everyone.
   - The waker waits 10 more minutes while the job's session is open.
3. The skill messages **every** running agent:
   - `web` gets "resume from your handoff at <file>".
   - `docs`, and anything else running, get "if you stopped because of the usage limit, carry on;
     otherwise ignore this".
   - Closed sessions with a pending handoff reopen with `claude --resume`.
4. `api` marks its own handoff resumed, runs `finish-resume`, and everything is back to watching.
   The finisher, the job and the coordinator are cleared for the next limit.

## When things change

- **The reset moves:** the weekly window also fills while `api` is finishing, so the reset is now
  days later. The hook records the later time and the waker follows it.
  - On `api`'s next tool call, the hook tells it to replace the job: CronDelete the old one, then
    CronCreate at the new time.
  - If the job runs early anyway, `continue` answers `early` with a new job time, never one in the
    past.
- **The login changes:** Lee runs `/login` with a work account before the reset. The restart is
  locked to the account that hit the limit.
  - The next hook call in any session (a subagent's too) cancels the round and goes back to
    watching.
  - The next main session the hook sees, and `api`, which held the job, are told:
    - the restart for `lee@example.com` is cancelled;
    - how many handoffs are pending, and that `/usage-handoff resume` restarts them on this account;
    - `api` is also told to delete its job with CronDelete.
  - The job sees `expired` when it runs and messages nobody, and the waker exits.
  - If the work account reaches its limit too, `api` is told again and a new round starts, locked
    to the work account. The old job, if it still runs, leaves the new round's job alone.
  - A token renewal for the same account changes nothing.
- **The usage reading fails while `api` is finishing:** above the threshold it can't see how much is
  left, so the hook tells it to stop.
- **A restart stalls:** if the restart stops halfway, the next limit still starts a new round with
  its own coordinator, finisher and job. A restart that finishes after a new limit started leaves
  that limit waiting.
- **An old job:** a job made for an earlier limit, or replaced by a newer one in another session,
  is `expired` too.
- **By hand:** `/usage-handoff continue` restarts everyone now, like `resume`
  (`continue --now`).
