# Use case: a status board that doesn't interrupt busy sessions

Ana runs four Claude Code sessions on one repo. Three of them are mid-task, and their pipelines
rewrite a one-line status file in `~/.claude/pr-dashboard/status/` whenever their PR changes. The
fourth went quiet an hour ago.

1. She types `/fleet-status`. The skill calls `ListAgents` and runs pr-dashboard's
   `status-dir --recent 15`. That prints the status folder as a native path (on Windows,
   a drive-letter path, not a Git Bash `/c/...` one), the current epoch, and the sessions whose line is
   non-empty and under 15 minutes old. Empty files and `_`-prefixed scratch files don't count.
2. The three current sessions get **no message**. Their lines become cards straight away:
   - `doing` becomes the description
   - the PR numbers become tags
   - `ask owner` becomes an ASK flag
   - a real `waiting on` becomes a BLOCKER
   - CI comes from `gh pr view`
3. Only the quiet session is asked. The request tells it to write its line to the status file,
   reading the file first if it exists, because the Write tool won't overwrite an unread file. It
   replies by message only if it can't write.
4. Ana runs `/fleet-status board` a few minutes later. The skill re-reads the files without
   messaging anyone, and the fourth card fills in.
