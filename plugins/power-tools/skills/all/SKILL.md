---
name: all
description: "Send one message to every running Claude agent and session, then close this session. Trigger on '/all <message>'."
user-invocable: true
disable-model-invocation: true
argument-hint: "[--at <time>] \"<message>\""
allowed-tools: ListAgents, SendMessage, ToolSearch, Bash, CronCreate
---

# All: message every running agent, then close this session

Sends `$ARGUMENTS` to every agent `ListAgents` shows, reports who got it, then closes this session. With `--at <time>` it does all that later, the next time the clock shows `<time>`. Only the owner runs this skill, because it ends the session.

`QUIT` below means `node "<this skill's base directory>/scripts/quit.mjs"`. `AT` means `node "<this skill's base directory>/scripts/at.mjs"`.

## Step 1: the message

1. If `$ARGUMENTS` starts with `--at`, the time is the next word, plus the word after that if it's `am` or `pm`. Take them off.
2. The message is what's left, trimmed, with one pair of surrounding quotes removed. If it's empty, reply `Usage: /all [--at <time>] "<message>"` and stop. **Don't close the session.**
3. With no `--at`, go to Step 3.

## Step 2: schedule it (only with `--at`)

A scheduled prompt can't start this skill, so the schedule carries the steps instead.

1. Run `AT <time>` with Bash. It prints a one-time `cron:` line for the next time the clock shows `<time>` (tomorrow if that's already passed today), and a `when:` line. If it exits 1, print its line and stop. **Don't close the session.**
2. If `CronCreate` is deferred, load it with `ToolSearch("select:CronCreate")`. Call it with the `cron:` value, `recurring: false`, and this prompt, with the message on the last line **word for word**:

   ```text
   Scheduled /all run: the owner typed `/all --at <time>` in this session and chose this time. Read <this skill's base directory>/SKILL.md and do its Steps 3 to 5 now, with the message on the next line, word for word.
   <message>
   ```

3. Reply in two lines with the run time CronCreate returned, then end the turn. Send nothing now, and **don't close the session**:

   ```text
   At Tue, Nov 10, 5:29 AM EST (job 78048f6b), "<message>" goes to every running agent, then this session closes. The job runs once, then it's gone.
   Keep this session open until then. To cancel, ask me to delete job 78048f6b.
   ```

When the job fires, the session does Steps 3 to 5 as written.

## Step 3: send it

1. If `SendMessage` is deferred, load it with `ToolSearch("select:SendMessage")`.
2. Call `ListAgents`. The targets are **every row**: your subagents, teammates, other local sessions, and cloud or Remote Control sessions. Skip only this session's own row, if it's listed.
3. Send the message **word for word** to each target in one batch of parallel `SendMessage` calls. Copy each name exactly as its row prints it. Add the row's ` [ref]` only when two rows share a name. Don't wait for replies: some kinds can't reply.

## Step 4: report

Print the report in a few short lines:

```text
Sent to 3: myrepo-4a, myrepo-7c, docs-cloud
Failed: old-session (not running)
```

If `ListAgents` showed no other agents, say `No other agents are running.`

## Step 5: close this session

- If no message was delivered (no targets, or every send failed), say so and **don't close**. The owner may want to retry.
- Otherwise run `QUIT` with Bash. It finds this session's own Claude process by walking up from itself, and ends it 3 seconds later. It never ends any other process.
- After it prints `closing this session`, end the turn with one line: `Closing this session.` Make no more tool calls.
- If `QUIT` exits with code 2, it couldn't find this session's process and closed nothing. Tell the owner to type `/exit`.
