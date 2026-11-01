# Request inbox for Claude sessions

Drop a request here, and the next Claude session that checks the inbox takes it,
does it and writes its answer back into the same file. Sessions check at start
(through the SessionStart hook from claude-power-tools) and whenever they run
`/request-inbox`. The full procedure is in the `request-inbox` skill's
`reference/protocol.md`.

## Filing a request

1. Create a Markdown file in this folder of the **main checkout**, not in a
   worktree. Name it `YYYY-MM-DD-short-name.md`; the date orders the queue.
2. Write the request in plain words. `TEMPLATE.md` has an optional layout.
3. That's it. Request files are git-ignored, so they never show up as dirty
   files or get committed.

## Where a request goes

| Folder | Meaning |
|---|---|
| top level (or `inbox/`) | New and not claimed yet. |
| `in-progress/` | A session claimed it and is working on it. The file names that session. |
| `needs-owner/` | The session stopped on a decision only you can make. Its question is at the bottom of the file. Answer under it and move the file back to the top level. |
| `done/` | Finished. The response at the bottom says what was done, with links. |

Every response is appended under a `## Response` heading, with the session name
and a UTC timestamp.
