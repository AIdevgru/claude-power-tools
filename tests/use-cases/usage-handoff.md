# Use case: handing off before the usage limit, and restarting after it

Lee has four Claude sessions working on one repo, some with subagents of their own, and a Claude
subscription with a 5-hour usage window.

## With the hook (the default)

1. Lee installs power-tools and does nothing else. After every prompt and tool call, each
   session's hook reads usage from a cache that every session shares, so the endpoint is asked at
   most once a minute near the limit and once every 10 minutes when usage is low.
2. The 5-hour window reaches 96%. On its next tool call, each session gets one note: wrap up,
   ask your subagents where they are, WIP-commit, and fill in the handoff file the hook just
   created. The file already has `Status: pending`, the session id, the folder and the branch.
   A subagent's own tool call gets a shorter note: stop at a safe point and report to the parent.
   Neither hears it twice in the same window.
3. The first session to cross the threshold records the reset time and starts the background
   waker.
4. After the reset, if any handoff is still pending, the waker starts one hidden Claude session
   (`claude -p`, no window, output in `resumer.log`) that runs `/usage-handoff resume`. Sessions
   still open are messaged and resume in their own window, so no new window appears for them; a closed one reopens with `claude --resume <its id>`, so it
   comes back with its whole conversation, even if it ran out before writing anything. That window
   closes by itself when Lee exits Claude. Only one hidden session ever starts per reset: a second
   waker can't re-take the first one's claim, and the hook won't start a waker once a resume is
   under way. With no pending handoffs, the waker starts nothing. `launch`
   won't reopen a session that is still open.
   If the machine rebooted while waiting, the waker is gone; the first hook call after the reset,
   in any session, starts a new one, which resumes straight away.
5. Every time Lee sees is in Lee's own time zone: the note says "resets 00:10 EST", the
   handoff's `Resets:` line reads `2026-11-02T05:10:00Z (00:10 EST)`, and `check` and
   `status` add `resumeAtLocal`. A reset on another day carries the date ("Mon, Nov 2 00:10 EST").
   Sessions are told to quote those, never a UTC time.
6. Lee doesn't want this on one machine, so they type `/usage-handoff off`. The hook stays
   silent in every session until `/usage-handoff on`. `USAGE_HANDOFF_HOOK=off` does the same for
   one environment.

## With a watcher loop

1. Lee runs `/loop /usage-handoff` in a fifth session. Each tick reads the same usage numbers
   `/usage` shows. At 40% it checks back in an hour; at 80% every 15 minutes; at 85% every 5; at 92% every
   2 minutes. The extra-usage credits don't count as a window.
2. The 5-hour window reaches 96%. The tick says `handoff` and gives the reset time. The watcher
   messages every session: stop starting work, ask your subagents where they are, WIP-commit, and
   write `~/.claude/usage-handoff/handoffs/<session>.md` with `Status: pending`, the folder,
   branch, PR, what's done, what's in flight and the next steps. It writes its own too.
3. `mark-handoff` records the reset time and starts a background waker, a detached process that
   doesn't depend on the session staying alive.
4. Until the reset, ticks say `wait` and sleep until just after it. No second round of messages.
   If the weekly window also fills up meanwhile, the wait moves to the later reset.
5. The window resets. The watcher's tick says `resume`. It claims the resume, so the waker won't
   repeat it, messages the sessions that are still open to resume from their handoff, and opens a
   new terminal running `claude` in the handoff's folder for each session that closed.
6. If the watcher ran out of usage itself and never woke up, the waker wakes three minutes after
   the reset, claims the resume and starts one Claude session that runs `/usage-handoff resume`.
   That session takes the claim over from the waker and does step 5.
7. A live session that was told to resume but still hasn't marked its handoff after 15 minutes
   shows up as `stalePending`, and the next tick opens a new session for it.
8. If the usage endpoint can't be read (logged out, expired token, network), the tick says
   `unknown` with the reason instead of guessing.

## Checking it works, and seeing it

1. Before trusting it with a real limit, Lee runs `/usage-handoff rehearse`. In about ten seconds
   it plays the whole cycle in a scratch folder with made-up usage: at 96% the note, the
   handoff and the waker; the same session isn't told twice; a subagent gets its short note;
   after the reset one hidden resume session (not really started); only one waker; then back to
   watching with the claim removed. Each step prints `ok` or `FAIL`. Nothing real is touched,
   but it lists leftovers in the real state folder, such as an old resume claim, which the next
   `finish-resume` or `reset` removes.
2. Lee wants to see the limit coming, so they run `/usage-handoff statusline` and, after saying
   yes, get a status line like `5h 64% (resets 00:10 EST) · week 49% (resets Sun 16:00 EST)`: each
   window carries its own reset, as a weekday when it's later this week. It reads the reading the
   hooks already share, so it never calls the usage endpoint. While handing off it says
   `handing off, back 00:10 EST`; a reading older than 15 minutes says how old it is.
3. The hook doesn't run after Read, Grep, Glob and other quick lookups. Each hook call costs a
   Node start, and those tools run most often; any prompt, command, edit, subagent, skill or MCP
   call still checks usage.
