---
name: screenreader
description: "Test a web page as a vision-impaired NVDA user would: sets up NVDA and its MCP server, then a persona that never sees the screen does the task you describe with keys and NVDA's speech, and you get a report of every barrier. Trigger on '/screenreader', 'test this with NVDA' or 'screen reader test'."
user-invocable: true
disable-model-invocation: false
argument-hint: "<url> <what to test> [--persona \"<who>\"] [--steps N] [--no-audit] | setup | verify | keys-off"
---

# Screen reader test

A nonsighted persona tries to do **`$ARGUMENTS`** on a web page using only NVDA: keys in, speech out. It never sees the page. The result is a report of how it went and every barrier it hit, each quoting what NVDA said. A transcript of everything NVDA said goes with it.

**Windows only.** NVDA runs on Windows. The persona drives NVDA through the [NVDA MCP add-on](https://github.com/InfiArtt/nvda-mcp) and its `nvda-mcp` server, which need NVDA 2026.3 or later.

**JAWS:** no MCP server can drive JAWS yet, so the persona can't run with it. NVDA is free and installs alongside JAWS.

`SR` below means `node "<this skill's base directory>/scripts/screenreader.mjs"`. It prints JSON. It owns the setup rules; act on what it prints rather than re-deriving them.

## The one rule: nobody looks at the page

The test is only worth anything if nothing in it sees the page. For the whole run, in this session and in the persona:

- No screenshots.
- No Claude in Chrome or built-in browser tools.
- No WebFetch of the page.
- No reading the page's HTML, and no `nvda_capture_control`, `nvda_inspect_html`, `nvda_find_html` or `nvda_get_object_tree`.

The persona agent ships with NVDA's keyboard and speech tools only. You, the tester, may use NVDA's own reports after the persona finishes (see Tester checks). A fix you suggest comes from what NVDA said. If the page's source is in this repo, you may name the file that renders an element after the run, never during it, and never in the persona's brief.

## Arguments

- **Page:** the first `http://` or `https://` address in `$ARGUMENTS`.
- **Task:** the rest of the words: what the persona should try to do ("sign up for the newsletter", "find the opening hours", "add a blue medium T-shirt to the cart").
  - If either is missing, ask once for both.
  - A task with no clear end ("check the page") becomes: find out what the page is for and use its main action.
- **`--persona "<who>"`:** who the persona is. Default: *an experienced NVDA user, vision impaired since birth, keyboard only, who browses with NVDA's quick navigation keys*. Examples: "new to NVDA, knows Tab and Enter only", "low patience, gives up after two tries".
- **`--steps N`:** the persona's step budget, default **60** key or typing actions.
- **`--no-audit`:** skip the tester checks.
- **`setup`:** run Setup and Verify, then stop.
- **`verify`:** run Verify only.
- **`keys-off`:** stop NVDA MCP pressing keys (`SR allow-keys --off`), then stop.

## 1. Setup

Run `SR detect`. Then act on its `next` field, one step at a time, and run `SR detect` again after each step. Each step changes one thing. If the same `next` comes back twice after you acted on it, stop: show the owner the step and the script's error, and say what to do by hand. Show each `warnings` line to the owner once.

First run only: if `reader` is null, ask with AskUserQuestion which screen reader to use. Options:
- **NVDA (Recommended)**: free; the persona can drive it.
- **JAWS**: no MCP server exists for it yet.

Then run `SR choose nvda` or `SR choose jaws`. If NVDA isn't installed, say so in the question; Setup installs it.

| `next` | What to do |
|---|---|
| `unsupported` | Say NVDA runs on Windows only, so this skill can't run here. Stop. |
| `jaws` | Show what `SR choose jaws` printed. Ask whether to use NVDA instead (it installs alongside JAWS). Yes → `SR choose nvda` and continue; no → stop. |
| `install-nvda` / `update-nvda` | Ask with AskUserQuestion. Options: **Install NVDA now (Recommended)**, **I'll install it myself** (nvaccess.org), **Stop**. Tell the owner that it downloads the latest NVDA from NV Access, checks its checksum, installs it, and that Windows asks for admin rights. On yes, run `SR install-nvda`. |
| `install-addon` | Tell the owner what happens: NVDA asks whether to install the NVDA MCP add-on (answer **Yes**), then restarts. Then run `SR install-addon`. If it fails, they can install "NVDA MCP" from NVDA's Add-on Store (NVDA+N, Tools, Add-on Store). |
| `restart-nvda` | `SR restart-nvda` (an add-on install is waiting for a restart). |
| `install-uv` | `SR install-uv`. uv runs the `nvda-mcp` server. |
| `register` | `SR register`. It registers the server for every project, pinned to the add-on's version. Sessions started earlier don't see it (see Verify). |
| `allow-keys` | Ask with AskUserQuestion. The persona works by pressing keys, which NVDA MCP blocks by default. Options: **Only in my browser (Recommended)** (the `browser` field, e.g. brave), **In any app**, **I'll set it in NVDA myself** (NVDA Settings, NVDA MCP). Run `SR allow-keys --apps <browser>`, `SR allow-keys --apps ""`, or wait for them. NVDA restarts, and it still asks once per start before the first key press. |
| `start-nvda` | `SR start-nvda`. NVDA starts talking. |
| `verify` | Go to Verify. |

## 2. Verify

1. Run `SR verify`. It starts the registered server the way Claude Code does, lists its tools and asks NVDA for its status.
   - Exit 0: setup works.
   - Otherwise, act on `problems`, then run it again, at most twice:
     - NVDA not reachable → `SR start-nvda`.
     - Keys not allowed → the `allow-keys` row.
     - The add-on and the server "do not match", or tools are missing → update both together. Run `SR install-addon` (it fetches the latest add-on; NVDA asks to install it), then `SR register --replace` to pin the server to the new version.
2. Check that this session has the tools: `ToolSearch("select:mcp__nvda__nvda_get_status,mcp__nvda__nvda_press_keys,mcp__nvda__nvda_get_speech_history,mcp__nvda__nvda_get_action_log,mcp__nvda__nvda_list_elements,mcp__nvda__nvda_audit_focus_order,mcp__nvda__nvda_list_windows,mcp__nvda__nvda_activate_window")`.
   - If they don't come back, the server was registered after this session started. Tell the owner to run `/mcp` and reconnect **nvda** (or restart Claude Code), then run the same `/screenreader` command again. Stop.
3. Call `nvda_get_status` and show one line: the NVDA version, the add-on version, and whether keys are allowed.

For `setup` or `verify`, report and stop here.

## 3. Before the run

1. **Test data.** If the task needs a sign-in, payment or personal details, ask once for a test account or test data. Without them, the persona uses obvious fake data, and the run stops at a sign-in it can't pass. Never give the persona the owner's real details unless the owner provides them for this test.
2. **Paths:** `SR paths --slug "<page name> <task in 3 words>"` gives the report and transcript paths. They go in `docs/accessibility/` in a git repo, otherwise in `~/.claude/screenreader/reports/`.
3. **Tell the owner**, in one message without asking a question:
   - The run takes a few minutes. NVDA will talk the whole time.
   - Keys are pressed in the browser, so don't touch the keyboard or mouse, and leave the browser in front.
   - The first key press of each NVDA start shows NVDA's "allow key presses?" question. Answer **Yes**.
4. **Open the page:** call `nvda_get_status`. Its `lastSpeechId` is `start`. Then run `SR open <url>` and `nvda_wait_for_speech` (timeout 15000) for the page to load.
5. **Check the foreground app.** Call `nvda_get_status`. If `foregroundApp` isn't the browser, use `nvda_list_windows` and `nvda_activate_window` to bring it forward.
6. **Unlock key presses.** Call `nvda_press_keys` with `["control"]`. It only silences speech, and it brings up NVDA's question now, while the owner is watching. If it fails with controlDenied, the owner said no: stop and say so.

## 4. The run

Launch the `screenreader-persona` agent: `power-tools-ui:screenreader-persona` when installed as a plugin, `screenreader-persona` when installed with the installer. Wait for it; don't run it in the background. Its brief has five parts:

- **Who:** the persona.
- **The task:** in the owner's words.
- **The page:** "The browser is open at <url>, in front, with NVDA running."
- **The budget:** `--steps`.
- **The test data:** what the owner gave, or "none: use obvious fake data".

Tell it nothing about the page that you know from anywhere but NVDA: no layout, no labels, no hints. If the persona agent isn't available, use a general-purpose agent with the same brief. Paste the persona's rules from its section below, and the report says the persona's tools weren't limited.

**If it stops early** because a key press was refused or NVDA stopped answering, check with `nvda_get_status`. Fix the cause with the owner (the allow-keys row, or `SR start-nvda`) and run it once more from the start. Two failures end the run; report what happened.

## 5. Tester checks

Skip these with `--no-audit`. Return to the page first: `nvda_press_keys ["control+home"]` (browse mode).

- `nvda_get_status`: the page title, from `foregroundWindow`. Is it specific to the page?
- `nvda_list_elements` with type heading, then landmark, link, form field and button (max 100 each). Look for:
  - no `h1`, or skipped heading levels;
  - no main landmark;
  - links or buttons named "click here", "read more" or "button", or names repeated across different targets;
  - form fields with no label.
- `nvda_audit_focus_order` (max_steps 60) from the top of the page. It flags unlabeled controls, silent controls, duplicate names and focus traps.

These are NVDA's views of the page, not pixels. Record them as "Tester checks", separate from what the persona met.

## 6. Evidence

Call `nvda_get_speech_history` with `after_id: start` (limit 2000; page with `after_id` if there's more), and `nvda_get_action_log` (limit 200). Write the transcript file with:
- the page, the task, the date and the NVDA and add-on versions;
- every key press or typed text from the action log, with its time;
- everything NVDA said, in order.

Replace any test password with `••••`.

## 7. The report

Write it to the report path, in Markdown, with these sections:

1. **Title:** `# Screen reader test: <task> on <page title or host>`, then the date, the page address and the transcript link.
2. **Outcome:** **Completed**, **Completed with difficulty** or **Not completed**, in one sentence, from the persona's result.
3. **The persona and the task:** who, what, the step budget and the test data used (described, not the values).
4. **Setup:** NVDA version, add-on and server versions, browser, NVDA's speech mode, and whether the persona's tools were limited.
5. **Effort:** steps and key presses used, and how long it took.
6. **Barriers:** a table, most severe first. Columns: severity, what the persona was doing, what NVDA said (quoted), why it's a barrier, WCAG 2.2 success criterion, suggested fix.
   - Severity is **Blocker** (the task can't be done without sight), **Serious** (done only by guessing or trial and error), **Moderate** (slower or confusing) or **Minor**. You may change the persona's severity; say why in the row.
   - Name the closest success criterion. Common ones:
     - 1.1.1 Non-text Content
     - 1.3.1 Info and Relationships
     - 2.1.1 Keyboard
     - 2.1.2 No Keyboard Trap
     - 2.4.1 Bypass Blocks
     - 2.4.2 Page Titled
     - 2.4.3 Focus Order
     - 2.4.4 Link Purpose
     - 2.4.6 Headings and Labels
     - 3.3.1 Error Identification
     - 3.3.2 Labels or Instructions
     - 4.1.2 Name, Role, Value
     - 4.1.3 Status Messages
   - The fix says what NVDA should have said and the usual way to get there (for example "a `<label>` on the email field" or "`aria-live="polite"` on the cart count").
7. **What worked:** short bullets.
8. **Walk-through:** the persona's step log, lightly cleaned: keys → what NVDA said → what the persona understood.
9. **Tester checks:** your findings from step 5, or "skipped".
10. **Method and limits:**
    - One persona, one run, one browser and NVDA's default settings; real users differ.
    - The persona heard speech as text, not audio. NVDA's sounds and braille weren't tested.
    - It isn't a full WCAG audit.

Don't invent barriers: each one cites speech from the transcript or the persona's log.

If this session can publish a private page or doc (an artifacts or docs connector), publish the report there too and give the link. The local file stays the source.

## 8. Tell the owner

- One line for the outcome.
- The barrier count by severity, and the top barrier in one line.
- The report and transcript paths (and the link if you published).
- One line saying NVDA MCP may still press keys in `<apps>`; `/screenreader keys-off` turns that off.

Never commit the report; the owner decides.
