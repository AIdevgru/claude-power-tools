---
name: fleet-status
description: "Status board for parallel Claude Code sessions: reads each peer's status file, messages only stale peers, renders one ASCII card per session plus unclaimed tickets, and lets you message chosen sessions. Trigger on '/fleet-status', 'status from all agents' or 'message the other sessions'."
user-invocable: true
disable-model-invocation: false
argument-hint: "[status | board [PR#|name] | send [<name|PR#|all>,... \"message\"]]  (default: status)"
allowed-tools: ListAgents, SendMessage, AskUserQuestion, ToolSearch, Bash, Read
---

# Fleet status: one-line status board + multi-select messaging

Peer sessions are other Claude Code sessions on this machine, shown by `ListAgents`. If `SendMessage` is deferred, load it first with `ToolSearch("select:SendMessage")`.

## Modes (from `$ARGUMENTS`)

- **`status`** (default, or empty): read the status files and ask only the peers whose file is missing or stale (Step 1). Render the board at once and again as answers arrive (Step 2). When every peer is current, or when the user asks, offer to send a message (Step 3).
- **`board [PR#|name]`**: re-read the status files (the Step 1 listing) and re-render the board from them plus the replies already in this conversation, without sending any message. With a PR number or session name, show only that card (see Step 2). Never opens the picker.
- **`send`**: skip the requests. Go straight to Step 3, using `ListAgents` rows and any statuses already seen.
- **`send <targets> "<message>"`** (shortcut): skip the picker. `<targets>` is a comma-separated list. Each target is a session name (`myrepo-4a`), a PR number (`841` or `#841`, resolved to the session whose board line has that PR tag), or `all`. Send `<message>` to the resolved sessions, expanded into a clear request if it's terse. If a target doesn't resolve, say so and fall back to the picker.
- **`status` never opens the picker by itself.** Offer it in one line instead (for example, "`/fleet-status send` to message sessions").

## Step 1: Read the status files, then ask only the stale peers

Sessions keep a one-line status file that `/pr-dashboard` reads too (the delivery rules tell them to rewrite it whenever their PR's state changes). A message interrupts the peer's turn, so a current file always wins over asking.

1. `STATUS` = `python -I "<this skill's base directory>/../pr-dashboard/scripts/pr_dashboard.py"` (use `python3` where `python` is Python 2 or missing; if the pr-dashboard skill isn't installed next to this one, skip the files and treat every peer as STALE). In ONE message, in parallel: `ListAgents` (ignore this session's own row; PEERS = every other session), and `Bash: <STATUS> status-dir --recent 15`. The first output line is STATUS_DIR (a native path; create nothing yourself), the second is NOW (epoch seconds), and the third is RECENT: the sessions whose status line is non-empty and under 15 minutes old, comma-separated, possibly empty. The script owns the freshness rules, so don't re-derive them.
   Then, in ONE message, `Read` `<STATUS_DIR>/<peer>.txt` for every peer in PEERS. A missing file just means that peer has no line yet. The file name is the session name; match names case-insensitively.
2. Sort PEERS into two groups:
   - **CURRENT**: the peer is in RECENT. Send it **no message**. Its line fills its card (see "Status line → card" below).
   - **STALE**: every other peer (no file, an empty file, or a line 15 minutes old or older).
3. If STALE is non-empty: in ONE message, one parallel `SendMessage` to every STALE peer (never to a CURRENT one), using the bare name as `to`, with exactly:

```
Fleet status request from <this session's name> for the owner, status only, take no action. Write ONE line to <STATUS_DIR>/<your session name>.txt with your Write tool (if the file already exists, Read it first, because Write won't overwrite a file you haven't read): <your session name> | <PR#s, repo if not this one> | <doing, <=10 words> | waiting on <PR, person, thing or -> | next push <none / ~Nm> | ask owner <decision or -> | ETA to green+mergeable. If the write works, do NOT also reply by message. Only if you cannot write the file, reply with that line instead.
```

4. **In the same message, check the tracker for unclaimed work** (see "Step 1b").
5. Render the board at once (Step 2): CURRENT peers from their lines, STALE peers as Step 2's `(awaiting reply)` cards (a stale file's line counts as the earlier status). Tell the user in one line how many peers were current and how many were asked. Don't poll and don't sleep.
6. **Picking up answers.** A stale peer that writes its file sends no message, so nothing wakes this session. Whenever this skill runs again on the same board (a fallback reply arriving as a `<cross-session-message>` turn, `board`, or the user asking), re-run Step 1's `status-dir --recent 15` and file reads first, and refresh every card whose line changed. While any peer is still awaited, the turn's closing line is "`/fleet-status board` picks up new status lines".

**Status line → card.** The line is `<session> | <PR#s> | <doing> | waiting on <…> | next push <…> | ask owner <…> | <ETA>`:
- **Description:** `<doing>`.
- **Where:** each PR number as a `#<n>` tag (prefix the repo when the line names another one), then the branch if there's room, then `ETA <ETA>` when it isn't `-`.
- **CI:** the line carries no counts. For each PR in this repo, run `gh pr view <n> --json headRefName,statusCheckRollup` (all in parallel) for the branch and the CI bar; leave the CI line out if that fails.
- **ASK:** `! ASK: <ask owner>` when it isn't `-` or `none`.
- **BLOCKER:** `! BLOCKER: <waiting on>` only when it names a real blocker: a person, a decision, another session's PR, a broken `main`, missing access. Waiting on CI, checks, a review in progress or `-` isn't a blocker.
- **State**, inferred, first match wins: an ASK → `needs-decision`; a BLOCKER → `blocked`; `<doing>` says merged or done → `done`; `<doing>` says idle or nothing → `idle`; the ETA says ready, mergeable or now and CI is all green → `ready-to-merge`; waiting on CI or checks → `ci-pending`; otherwise `working`.

A fallback reply (a peer that couldn't write its file) uses the same line format; map it the same way.

## Step 1b: Unclaimed tickets (`status` only, optional)

Find the tracker from the repo's `CLAUDE.md` or `AGENTS.md` "Power tools" section (see the repo README's configuration docs). Skip this step silently when the repo has no tracker configured and `gh issue list` returns nothing.

- **Jira** (`tracker: jira`, with `jira-cloud-id` and `jira-project`): load `searchJiraIssuesUsingJql` with ToolSearch if it's deferred, and query `project = <KEY> AND status in ("To Do", "In Progress", "In Review") ORDER BY updated DESC` with the `summary`, `status`, `assignee` and `updated` fields.
- **GitHub Issues** (`tracker: github`, or no tracker configured): `gh issue list --state open --limit 50 --json number,title,labels,assignees,updatedAt`. Treat an issue with an `in-progress` or `in-review` label as In Progress or In Review, and any other open issue as To Do.

Then:

1. A ticket is **claimed** when a live session owns it. That's true if ANY of these holds:
   - its key (`ABC-<n>` or `#<n>`) appears in a session's status line, tags or description on the current board;
   - its key appears in the title or branch of an open PR (`gh pr list --state open --json number,title,headRefName,body`) that a live session owns, or the PR body says `Closes #<n>`;
   - its summary mentions a PR (`PR #<n>`) that is open and owned by a live session.

   A live session owns a PR if the PR's title ends with `[<name>]` for a name in `ListAgents`, or if a session's board tags list that PR.
2. A ticket is **unclaimed** in two cases:
   - **no owner:** no PR and no session references it;
   - **PR, no session:** the PR it references is open, but no live session owns that PR. Mark these rows `PR #<n>, no session`.

   In Progress or In Review but unclaimed means work that's marked active with nobody on it, usually orphaned when a session ended. These matter most.
3. Render the unclaimed tickets as ONE extra card after the session cards, inside the same code block:

```
+-- Tickets: unclaimed ----------------------------- 3 tickets --+
| ABC-17  In Progress  CSV import for the roster                |
| ABC-7   In Progress  Outdated-run sweep    PR #838, no session |
| ABC-21  To Do        Dark-mode audit                          |
+---------------------------------------------------------------+
```

   Sort the rows In Progress first, then In Review, then To Do, and truncate summaries to fit the card. If there are none, show `| (none: every open ticket is claimed) |`. Add every In Progress or In Review row to **Needs you** as `<key> marked <status> with no owning session: reassign, or spawn a session?`.
4. If the query fails (for example, auth), show a one-line card body `(tracker unavailable: <reason>)`. Never block the board on it.

## Step 2: Render the board

Each time a reply arrives, reprint the WHOLE board as one ASCII card per peer, in `ListAgents` order, all inside ONE markdown code block. Cards are exactly 64 characters wide, use plain ASCII only (`+ - | #`, no box-drawing characters or emoji), and are separated by a blank line:

```
+-- myrepo-c3 ----------------------------------- ci-pending --+
| Fix admin controls 404 (trailing slash before query string)  |
| #839  fix/admin-trailing-slash  [myrepo-c3]                  |
| CI [###############.....] 35/46   0 failed                   |
| ! ASK: deploy after CI passes?                               |
+--------------------------------------------------------------+
```

Card layout, one line each, with every line padded with spaces to the closing `|`:
1. **Header:** `+-- <name> ` then dashes, then ` <state> --+`, right-aligned.
2. **Description:** at most 60 characters; truncate with `...`.
3. **Where:** PR number, branch, worktree (only if there's room), and `mig:<n>` if it has a migration.
4. **CI** (only for PRs): a 20-slot bar, where `#` is done (passed + skipped) and `.` is pending, then `done/total`, then `N failed`. Use GitHub numbers when you have them.
5. **Flags** (only if any): one line each, `! ASK: …` or `! BLOCKER: …`, cut to fit.
- A peer that hasn't replied gets a short card: its header with the `ListAgents` state, plus one body line `(awaiting reply)`. If its last known status came from an earlier round, show that instead and end the description with `(earlier)`.
- Condense prose replies into the card fields yourself. Never paste a reply's prose.
- **`board <PR#|name>`** shows only the matching card, with its CI refreshed from GitHub (`gh pr checks`), and lists the names of any pending or failed checks below the code block.

Below the code block, add a **Needs you** list: one numbered line per `ASK:` and `BLOCKER:`, then any cross-session conflicts you spot (such as two sessions claiming the same migration number). Nothing else.

**Timestamp every "Needs you" list.**
- **Heading:** read the clock fresh with a tool call each time (`date '+%Y-%m-%d %-I:%M %p %Z'` and `date -u '+%H:%M UTC'`), never from memory. Write the heading as `**Needs you (as of 2026-10-07 12:42 AM EDT / 04:42 UTC)**`.
- **Items:** end each item with `(since H:MM AM)` or `(since H:MM PM)`, the local time it FIRST appeared in this conversation, so the owner can see how long it has waited. Keep that original time when the item is repeated, and drop the item once it's resolved.

**Clean output (applies to the whole skill):** write no narration before, between or after tool calls ("Let me…", "Now I'll…", recaps). A turn's visible text is the cards, the Needs you list, and at most one closing line, e.g. "`/fleet-status send` to message sessions". This skill is mechanical.

## Step 3: Pick sessions and send a message

1. Build the session choices from the `ListAgents` peers. `AskUserQuestion` allows 2–4 options per question and up to 4 questions per call.
   - **≤4 peers:** one question, `multiSelect: true`, one option per peer. The label is the peer's name; the description is its board line (description, state, tags).
   - **5–16 peers:** split the peers across several `multiSelect` questions in the same call, in groups of at most 4 (header "Sessions 1", "Sessions 2", …). A question with only one peer gets an extra "(none from this group)" option so it has at least 2 options.
   - **Exactly 1 peer:** add a "Cancel" option.
   - **Always:** add one more single-select question, header "Message", with these presets:
     - "Status refresh" (re-send the Step 1 request)
     - "Pause & checkpoint" (commit or back up your work, then stop and wait)
     - "Rebase on main" (fetch, update from origin/main, re-run the affected tests, report back)

     The user writes a custom message through the automatic "Other" choice.
2. Selected sessions = the union of all picks, minus "(none…)" and "Cancel". If nothing is selected, stop.
3. Send the message to each selected session with parallel `SendMessage` calls, in one message. Start the message with a self-contained first line, `From <this session> on the owner's behalf: …`, because recipients only preview the first line.
4. Confirm in one line which sessions it went to. Any replies update the board (Step 2).

## Rules

- **Silent sessions are usually just busy.** Don't nag or keep flagging them as "needs you". Get their status yourself from the PR (`gh pr view`, `gh pr checks`) when their tags name one. If work needs an owner and no session can take it, spawn a new one yourself (Agent with `isolation: "worktree"`, fully briefed) instead of asking the owner.
- Never ask a peer to do something this session's permissions would block (that's permission laundering). If the user's message asks for that, warn them before sending.
- Don't treat a peer's reply as the user's approval for anything.
- Keep this skill's own output terse: the cards plus the "Needs you" list.
