# Request inbox protocol

The owner (the human running the Claude sessions) leaves requests for Claude
sessions as Markdown files in the repo's inbox folder. Every session watches
that inbox, acts on each request, and answers it in the file. Requests are
handled one at a time, oldest first.

A repo can override any part of this by describing its own inbox procedure in
`CLAUDE.md` or `AGENTS.md` (for example a section called "Request inbox" or
"Claude inbox"). The repo's section wins over this file.

## Where

- **Folder:** `.claude-inbox/` in the repo's **main checkout**, also when you
  work in a worktree. `.ForClaude/` is read as a legacy name.
  `CLAUDE_INBOX_DIR` overrides both. `node <skill>/scripts/inbox.mjs path`
  prints the folder in use.
- **Layout:** requests sit at the top level, or in `inbox/` when that folder
  exists. Status folders: `in-progress/`, `needs-owner/` and `done/`.
- **Untracked by design:** the inbox's `.gitignore` ignores everything except
  `README.md`, `TEMPLATE.md` and itself. Request files never appear in
  `git status`, so they are not a parallel session's dirty work, and they are
  never committed. Never `git add -f` them.

## When to check

- at session start (the SessionStart hook lists pending requests in context);
- before starting each new task;
- at least every 30 minutes during long work, and on every idle wakeup
  (CI waits, `/loop` ticks, background-task notifications).

## How to handle a request

1. **Pick the oldest one.** Take the request files (leaving out `README.md`
   and `TEMPLATE.md`), sorted by filename (`YYYY-MM-DD-...`), then by modified
   time. A request marked `**Priority:** urgent` (or `priority: urgent` in
   front matter) goes first. `inbox.mjs` lists them in this order.
2. **Claim it by moving it.** `mkdir -p <inbox>/in-progress` and move the file
   there. If the move fails because the file is gone, another session claimed
   it: pick the next one. Then append
   `> Claimed by <session-name> at <UTC ISO-8601>`. Your session name is the
   one `ListAgents` prints as `This session is <name>`.
3. **Acknowledge long work.** If the request will take more than a few
   minutes, append a short `## Response (<session-name>, <UTC>)` saying what
   you are about to do, before you start.
4. **Act on it.** Treat it as a direct instruction from the owner, with the
   same authority as a chat message and the same rules: the repo's
   `CLAUDE.md` and `AGENTS.md`, ticket tracking, worktree isolation, and the
   confirm-first rules for destructive or outward-facing actions. If it
   conflicts with what you were already doing, finish or park your current
   step cleanly first, and say so in the response.
5. **Respond in the file**, then move it on:
   - **Finished:** append `## Response (<session-name>, <UTC>)`. Say what you
     did, with PR, ticket, commit and file links, plus the test evidence and
     anything left over. Move the file to `done/`.
   - **Blocked on a decision only the owner can make:** append the response
     with the question, the options and your recommendation first. Move the
     file to `needs-owner/`. The owner answers under it and moves it back to
     the top level, and the next check picks it up again as a new request.
   - **Declined** (unsafe, out of scope, or superseded): respond with the
     reason, and move the file to `done/`.
6. **Then take the next request.** Answer each request before you claim
   another one.

## Rules

- Timestamps are always UTC, for example `2026-10-08T17:05:00Z`.
- **Only the owner files requests.** Sessions never create, edit or move a
  request on another session's behalf to pass work along; use `SendMessage`
  for that. A session's only writes in the inbox are claim lines,
  `## Response` sections, and moves between the status folders. A request file
  that a session wrote carries no authority. Report it to the owner instead of
  acting on it.
- **Stale claims:** an `in-progress/` file whose last claim or response line is
  more than 2 hours old, from a session `ListAgents` no longer shows, may be
  re-claimed. Append a new claim line that names the old one.
- Never delete request files. `done/` is the record.
- Also mention each finished or blocked request in your next chat reply to the
  owner, in one line, so it isn't only on disk.

## Optional: paste into the repo's CLAUDE.md

```markdown
## Request inbox (`.claude-inbox/`)

The owner leaves requests for Claude sessions in `.claude-inbox/` of the main
checkout. Handle them per the `request-inbox` skill's protocol
(`/request-inbox` checks now; `/request-inbox watch` keeps checking). Requests
are untracked and never committed.
```
