# Use case: a vision-impaired NVDA user tries a sign-up form

Lee builds the marketing site for a small shop. Before a launch, Lee wants to know whether someone
who uses a screen reader can join the newsletter, without Lee guessing at it with a mouse and a
checklist. Lee's machine runs Windows and has Claude Code with the power-tools-ui plugin.

## The first run sets everything up

1. Lee types `/screenreader https://shop.example.com join the newsletter`.
2. The skill runs `screenreader.mjs detect`. It finds no screen reader yet and asks which one to
   use: **NVDA (Recommended)** or **JAWS**. Lee picks NVDA, and `choose nvda` records it in
   `~/.claude/screenreader/state.json`.
   - Had Lee picked JAWS, the skill would say that no MCP server can drive JAWS yet and offer NVDA,
     which installs alongside it.
3. `detect` says `next: install-nvda`, and the skill asks before installing.
   - `install-nvda` reads NV Access's update service, downloads the newest stable NVDA and checks
     the download's SHA-1 against the published one.
   - It installs NVDA silently. Windows asks Lee once for admin rights.
   - An NVDA older than 2026.3 is offered the same update, because the add-on needs 2026.3.
4. `next: install-addon`. The script downloads the NVDA MCP add-on's latest release from GitHub and
   checks its SHA-256 against the digest GitHub publishes. It opens the file, so NVDA asks Lee
   whether to install it. Lee answers Yes, and the script restarts NVDA.
5. `next: register`, because uv is already on Lee's machine (otherwise `install-uv` comes first).
   `register` runs `claude mcp add --scope user nvda -- uvx nvda-mcp==1.1.0`, pinned to the add-on's
   version, so the server and the add-on always match.
6. `next: allow-keys`. The add-on doesn't let MCP clients press keys until the owner allows it, so
   the skill asks: **Only in my browser (Recommended)**, **In any app**, or **I'll set it in NVDA
   myself**.
   - Lee picks the browser. `allow-keys --apps brave` quits NVDA, backs up `nvda.ini`, and sets
     `allowControl = True` and `allowedApps = brave` in its `[nvdaMcp]` section.
   - The browser name comes from Windows' default-browser setting.
   - Then it starts NVDA again. NVDA still asks once per start before the first key press.
7. `next: verify`. `verify` starts the registered server the way Claude Code would, completes the
   MCP handshake and lists the tools. It checks that every tool the persona needs is there. It asks
   NVDA for its status and checks that key presses are allowed.
8. The server was registered during this session, so the session itself doesn't have the nvda
   tools yet. The skill tells Lee to reconnect **nvda** in `/mcp` and run the same command again.

## The test

1. Lee reruns the command. `detect` says `verify`, the check passes, and the session has the tools.
2. The skill warns Lee: NVDA will talk for a few minutes, don't touch the keyboard or mouse, and
   answer Yes when NVDA asks about key presses.
   - It opens the page with `open https://shop.example.com`. Only http and https addresses are
     accepted.
   - It presses Control once, which only silences speech. That brings up NVDA's question while
     Lee is watching.
3. The skill launches the `screenreader-persona` agent. Its brief has five parts: an experienced
   NVDA user, vision impaired since birth; the task; the page; a 60-step budget; and fake test data.
   - The agent's only tools are NVDA's keyboard and speech tools: press keys, type, hear speech,
     the Elements List, find, and browse or focus mode.
   - It has no screenshot, no HTML, no accessibility-tree tool and no browser automation, so it
     can't see the page.
4. The persona presses `h` and hears "Join our newsletter, heading level 2". It presses `f` and
   hears "edit, blank". There's no label, so it guesses that this is the email field. It types
   `test@example.com`. It presses `b` and hears "button": the button has no name. It presses it
   and hears nothing.
   - The persona can't tell whether it worked. It reports **Completed with difficulty** and lists
     three barriers, each quoting NVDA.
5. The skill runs its own checks with NVDA's lists and focus-order audit. There's no main landmark,
   and two links named "Read more" go to different pages.
6. It saves everything NVDA said since the run began, and every key press from the add-on's action
   log, as a transcript.

## The report

The report goes to `docs/accessibility/2026-11-10-shop-newsletter-screenreader.md` in Lee's repo,
because Lee ran it in a git repository. The transcript goes beside it.

- The barrier table puts the unlabeled email field first (Serious, 1.3.1 and 3.3.2). Next comes the
  nameless button (Serious, 4.1.2). Last, the silent confirmation is a Moderate barrier under 4.1.3
  Status Messages. Its fix is an `aria-live="polite"` region.
- Each barrier quotes what NVDA said, so Lee's developer can hear the same thing.
- "Method and limits" says it was one persona, one run, with NVDA's default settings. It says this
  isn't a full WCAG audit.

When Lee is done, `/screenreader keys-off` turns key presses back off. Reading still works.

## When something isn't right

- **Not on Windows:** `detect` says `unsupported`, and the skill explains that NVDA is Windows-only.
- **Version mismatch:** an unpinned `nvda-mcp` 1.1.0 server is talking to a 1.0.0 add-on. `verify`
  says they "do not match". The skill runs `install-addon` to update the add-on, and NVDA asks Lee
  to confirm. Then `register --replace` pins the server to the new version. A pinned server that
  differs from the add-on is warned about by `detect` already.
- **NVDA won't start from a script:** installed NVDA is a uiAccess program, so the script starts it
  (and its installer) through `start`, the way Explorer does.
- **NVDA isn't running:** `verify` says NVDA is not reachable, and the skill runs `start-nvda`.
- **Lee said No to key presses:** the run stops and says so. It never retries.
