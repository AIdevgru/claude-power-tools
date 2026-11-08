---
name: all
description: "Send one message to every running Claude agent and session, then close this session. Trigger on '/all <message>'."
user-invocable: true
disable-model-invocation: true
argument-hint: "\"<message>\""
allowed-tools: ListAgents, SendMessage, ToolSearch, Bash
---

# All: message every running agent, then close this session

Sends `$ARGUMENTS` to every agent `ListAgents` shows, reports who got it, then closes this session. Only the owner runs this skill, because it ends the session.

`QUIT` below means `node "<this skill's base directory>/scripts/quit.mjs"`.

## Step 1: the message

The message is `$ARGUMENTS`, trimmed, with one pair of surrounding quotes removed. If it's empty, reply `Usage: /all "<message>"` and stop. **Don't close the session.**

## Step 2: send it

1. If `SendMessage` is deferred, load it with `ToolSearch("select:SendMessage")`.
2. Call `ListAgents`. The targets are **every row**: your subagents, teammates, other local sessions, and cloud or Remote Control sessions. Skip only this session's own row, if it's listed.
3. Send the message **word for word** to each target in one batch of parallel `SendMessage` calls. Copy each name exactly as its row prints it. Add the row's ` [ref]` only when two rows share a name. Don't wait for replies: some kinds can't reply.

## Step 3: report

Print the report in a few short lines:

```text
Sent to 3: myrepo-4a, myrepo-7c, docs-cloud
Failed: old-session (not running)
```

If `ListAgents` showed no other agents, say `No other agents are running.`

## Step 4: close this session

- If no message was delivered (no targets, or every send failed), say so and **don't close**. The owner may want to retry.
- Otherwise run `QUIT` with Bash. It finds this session's own Claude process by walking up from itself, and ends it 3 seconds later. It never ends any other process.
- After it prints `closing this session`, end the turn with one line: `Closing this session.` Make no more tool calls.
- If `QUIT` exits with code 2, it couldn't find this session's process and closed nothing. Tell the owner to type `/exit`.
