# Use case: seeing every Claude account's usage and resets

Lee has two Claude subscriptions: a personal Max plan (`lee@example.com`) and a seat on their
company's Team plan (`lee@acme.dev`). When one runs out, Lee logs in to the other. Lee already put
usage-handoff in the status line with `/usage-handoff statusline`.

## Following the current account

1. The status line starts with who is logged in:
   `lee@example.com · 5h 64% (resets 12:10 AM EST) · week 49% (resets Sun 4:00 PM EST)`.
2. Every time usage-handoff reads usage (a hook call, a status line refresh after a login, or a
   `/usage-handoff` tick), it files the reading under the account it was taken with, in
   `~/.claude/usage-handoff/accounts.json`: the email, the plan (`Max 5x`), the organization for a
   Team or Enterprise seat, each window's percentage and reset, and when the account was logged
   in. Who is logged in comes from Claude Code's own `.claude.json`; the token never leaves the
   credentials file. A reading that is still in the cache is filed once, not on every call.
3. The line starts with the session's model, as Claude Code names it:
   `Opus 5.5 · lee@example.com · 5h 64% (resets 12:10 AM EST) · ...`. Lee runs `/model` and picks
   Sonnet for a quick chore, and the next refresh reads `Sonnet 5.5 · lee@example.com · ...`. It
   comes from the JSON Claude Code sends the status line command, so it's right for each session,
   and running `statusline` by hand in a terminal just leaves it out.

## Switching accounts

1. The 5-hour window on the personal account is full, so Lee runs `/login` with the work account.
2. The next hook call or status line refresh sees the new login, reads usage at once and files it
   under the work account, which becomes the current one ("logged in since 9:02 AM EST"). The
   status line now reads `lee@acme.dev (+1) · 5h 12% (resets ...) · week 30% (resets ...)`: `(+1)`
   is the personal account, which keeps its last numbers and resets.
3. Claude Code saves the new token a moment before it saves who the account is. A reading taken in
   that moment isn't filed under the old account: it waits for the next call, when both agree.
4. Logging back in to the personal account later files the next reading there again and moves its
   "logged in since" to now.

## Seeing them all

1. Lee Ctrl+clicks the status line (Cmd+click on macOS). The whole line is a link to
   `accounts.html` beside `accounts.json`, which opens in the browser.
2. The page has one card per account, the logged-in one first with a "Logged in" badge, then the
   most recently used. Each window has a meter, its percentage, its reset time and a countdown
   (`resets 7:59 PM EST (in 2 h 12 min)`). The meter turns amber within 15 points of the handoff
   threshold and red at it, with "near the limit" or "at the limit" written beside it. A window
   whose reset has passed since its reading shows an empty meter and
   `reset Sun, Nov 8 7:47 PM EST (was 97%)`: Lee can switch back to that account.
3. The page keeps its countdowns current while it is open, and a reset that passes turns that
   window to "reset". It reloads every minute to pick up new readings. It follows the system's
   light or dark mode and fits a narrow window.
4. In the terminal, `/usage-handoff accounts` prints the same list, one line per account, the
   logged-in one starred, then the page's link. `--json` gives the raw record.

## When something is off

1. Lee logs out. No account is current, and the status line says
   `usage: not logged in with a Claude subscription (no OAuth token) · 2 accounts`. It is still a
   link, so Lee can check which account resets first before logging in again.
2. A reading fails (the saved token has expired). The account keeps its last good numbers, and
   the page notes the failure and when it happened.
3. Lee no longer uses an old side account, so they run
   `/usage-handoff accounts forget side@example.org`, and it's gone from the list and the page.
4. Lee's other terminal shows the link's escape codes as text, so its status line command uses
   `statusline --no-link`.
