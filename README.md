# claude-power-tools

Skills and hooks for running several [Claude Code](https://claude.com/claude-code) sessions on one
repository without them stepping on each other's work.

- **Coordinate sessions:** a manager that keeps them moving, a status board, a PR and CI
  dashboard, an inbox you drop requests into, and one message to every session at once.
- **Ride out usage limits:** near the limit every session writes a handoff and stops, and the work
  restarts by itself at the reset. A status line shows the model, the account and each window's
  usage.
- **Deliver work:** take a plan, ticket or PR all the way to a reviewed pull request.
- **Design and test UI:** mockups, score-gated critique and polish, a screen reader test with NVDA,
  and videos rendered to MP4.
- **Start projects:** go from an empty folder to a running, deployed app.
- **Stay safe:** a hook blocks the git commands that lose another session's work.

Not running parallel sessions? The delivery and project skills work fine on their own.

**What it never does:** force-push, skip CI, or deploy anything except through `/deploy`, which
you start yourself and which asks before anything goes live. Every skill follows your repo's own
`CLAUDE.md` and `AGENTS.md` first.

**Terms:** the skills call you, the person running the sessions, the *owner*. Other Claude Code
sessions on the same repo are *peers*.

[Start here](#start-here) · [Install](#install) · [Top commands](#top-commands) ·
[Skills](#skills) · [Hooks](#hooks) · [Configuration](#configuration) ·
[Development](#development) · [License](#license)

## Start here

| If you... | Start with |
|---|---|
| run one session and want a task built, reviewed and opened as a PR | `/implement-to-pr "<what to build>"` |
| run several sessions on one repo | `/pr-dashboard`, then `/loop /fleet-manager` |
| are starting a new app from an empty folder | `/new-project <name> "<one line>"` |

Everything else builds on those three. You don't need to learn the rest to get value.

## Install

You need Node 20+, git and the GitHub CLI (`gh`, signed in). `pr-dashboard` and `fleet-status`
also need Python 3.10+.

The collection comes as three plugins. Install the ones you want:

| Plugin | What you get |
|---|---|
| **power-tools** | Coordinating sessions, the delivery pipelines, usage-handoff and its status line, git-guard, and their hooks. Start here. |
| **power-tools-ui** | The UI skills (`ux-mockup`, `ui-critique-loop`, `ui-finalize`, `screenreader`), `video` for Remotion videos, plus the bundled Impeccable. The pipelines use it for their UI gate when it's installed. |
| **power-tools-projects** | `new-project`, `project` and `deploy`. Needs **power-tools-ui** for the mockup and splash-page steps. |

**Plugin** (recommended):

```text
/plugin marketplace add aidevgru/claude-power-tools
/plugin install power-tools@aidevgru
/plugin install power-tools-ui@aidevgru          # optional
/plugin install power-tools-projects@aidevgru    # optional
```

Plugin skills carry the plugin's name: `/power-tools:pr-dashboard`, `/power-tools-ui:ux-mockup`.

**Or the installer**, for short names like `/pr-dashboard`:

```sh
git clone https://github.com/aidevgru/claude-power-tools
cd claude-power-tools
node scripts/install.mjs --dry-run                  # show what would change
node scripts/install.mjs --link                     # core, linked so `git pull` updates it
node scripts/install.mjs --link --with ui,projects  # or --all; add graphify with --with graphify
```

Pick **one** method. Using both runs every hook twice. The installer backs up
`~/.claude/settings.json` before adding hooks, never removes your settings, and changes nothing
when run twice. Options and the opt-in graphify skill are covered in
[docs/installer.md](docs/installer.md).

Either way, open `/hooks` once (or restart Claude Code) so running sessions load the hooks.
Update later with `/update` (it shows what would change) and `/update --force` (it applies it).

### Upgrading from 0.5

0.6 split the single `claude-power-tools` plugin into three, and moved the skill folders. The 0.5
`/update` can't follow that, so upgrade once by hand. After that, `/update` works again.

- **Plugin:**

  ```text
  /plugin marketplace update aidevgru
  /plugin install power-tools@aidevgru
  /plugin install power-tools-ui@aidevgru          # if you used the UI skills
  /plugin install power-tools-projects@aidevgru    # if you used new-project or deploy
  ```

- **Linked install:** `git -C <clone> pull --ff-only`, then
  `node <clone>/scripts/install.mjs --link --all`. This re-links every skill to its new folder.
- **Copied install:** from a fresh clone, run `node scripts/install.mjs --force --all`.

## Top commands

Each line is something you can type as-is. With the plugin, put the plugin's name in front, as in
`/power-tools:pr-dashboard`.

**See what's going on**

```text
/pr-dashboard                     Open PRs in merge order, their CI, queue ETAs and what needs you
/pr-dashboard line                The same, as one line
/fleet-status                     One card per running session, from their status lines
/fleet-status send all "rebase on main and re-run your tests"
                                  Message every session at once
/all "commit your work as WIP"    Message every agent, then close this session
/all --at 5:30 "continue"         The same, at the next 5:30
```

**Keep several sessions moving**

```text
/loop /fleet-manager              Every tick: unblock sessions, fix conflicts and red CI, list
                                  what only you can decide. Asks manual or auto merges first.
/fleet-manager --deploy manual    Switch back to "every merge waits for me"
/request-inbox init               Create .claude-inbox/; drop a .md file in it to hand off a task
/request-inbox watch              Keep checking the inbox every 15 minutes
/usage-handoff off                Turn off the usage hook: near 95%, every session writes a
                                  handoff and stops; the work restarts when the limit resets
/usage-handoff accounts           Usage and resets for every account you've logged in with
/usage-handoff statusline         Put the model, account and usage in Claude Code's status line
/show-email off                   Leave the account out of the status line (/show-model, /show-usage
                                  switch the other parts; all start on)
```

**Build and ship**

```text
/implement-to-pr "add CSV export to the Reports page"
                                  Builds it with subagents, opens a PR, reviews until clean
/implement-to-pr docs/plans/billing.md --review-plan --merge
                                  Reviews the plan against the code first; merges once green
/finish-pr 142                    Finishes an open PR: remaining work, two reviews; never merges
/ticket-to-pr ABC-12              One Jira ticket (or #42 for a GitHub issue) to a reviewed PR,
                                  then asks you: merge or hold
/ticket-triage                    Analyzes new tickets against the code; you pick which to act on
/issues-to-plan docs/qa-bugs.md   Turns an issue list into a verified, PR-sequenced plan
/combine-prs 101 104 105          Folds several PRs into one integration PR
/drain-pr-queue                   Merges every green PR one at a time, updating conflicting ones
```

**Design UI** (power-tools-ui)

```text
/ux-mockup "onboarding flow"       UX plan plus an interactive mockup; changes no product code
/ui-critique-loop --score 36 http://localhost:5173/settings
                                  Fixes and re-scores a page until it beats 36/40
/ui-finalize src/routes/settings  Release finish: score gate, one bold idea you pick, harden, polish
/screenreader http://localhost:5173 "join the newsletter"
                                  A vision-impaired NVDA user tries it by keys and speech; barrier report
/video "20 s teaser for our CLI, 3D logo spin, three feature cards" --size vertical
                                  Storyboard, Remotion code, checked stills, then an MP4
```

**Projects** (power-tools-projects)

```text
/new-project habit-tracker "track daily habits on phone and desktop"
                                  Empty folder to running app, step by step; resumable
/new-project resume               Pick up where the last session stopped
/deploy                           Splash page on GitHub Pages and the app on its own domain
```

**Safety and upkeep**

```text
/git-guard check "git stash"      Would the guard block this command, and why?
/git-guard enable merge-gate      Claude merges only PRs you approve with "approve merge #N"
/update                           What a newer version would change (--force applies it)
```

## Skills

Skills marked † start only when you type them; Claude won't pick them on its own.

### Coordinate sessions (power-tools)

`fleet-manager` and `fleet-status` need two or more sessions on the repo. `pr-dashboard` and
`request-inbox` are useful with one.

| Skill | What it does | Needs |
|---|---|---|
| **fleet-manager** | Reads the dashboard, session statuses and inbox; gives each blocker one owner; gets conflicts and red CI fixed; combines piled-up PRs; lists what only you can decide. Run as `/loop /fleet-manager`. | `pr-dashboard`, `combine-prs`, `request-inbox` |
| **all** † | `/all "<message>"` sends the message to every running agent and session, then closes this session. `--at 5:30` does it at the next 5:30 instead, through a one-time job in this session. | — |
| **fleet-status** | Reads each session's status line (asking only those whose line is stale), shows a card per session plus unclaimed tracker tickets, and lets you message the sessions you pick. | — |
| **pr-dashboard** | Shows open PRs in merge order with CI, queue ETAs, owners and a "Needs you" list. A script gathers every fact. | Python 3.10+ |
| **request-inbox** | Handles requests you drop in `.claude-inbox/`: claims each one, acts on it, and answers in the file. | — |
| **show-model**, **show-email**, **show-usage** † | Switch one part of usage-handoff's status line on or off: the session's model, the logged-in account, or each window's usage and reset. All start on; `/show-email` with no argument flips it, `on` or `off` sets it. | `usage-handoff` |
| **usage-handoff** | A hook, on by default, that watches your Claude usage limits. Near the top it has every session and its subagents write a handoff, and one session uses up the rest of the window. A restart job at the reset tells every running agent to carry on and reopens closed sessions with `claude --resume`. Logging in to another account cancels the restart. `/usage-handoff off` turns it off; `/loop /usage-handoff` adds a watcher session. It also keeps each account you log in with, so `/usage-handoff accounts` (or a click on its status line) shows every account's usage and resets. `/usage-handoff statusline` sets up that status line: `Opus 5.5 · lee@example.com (+1) · 5h 64% (resets 12:10 AM EST) · week 49% (resets Sun 4:00 PM EST)`. | A Claude subscription login |

### Deliver work (power-tools)

Which one to use:

| You have | Use | Merges? |
|---|---|---|
| A task, plan or ticket to build (`--review-plan` improves the plan first) | `implement-to-pr` | Only with `--merge` |
| An existing PR to finish | `finish-pr` | Never |
| One tracker ticket | `ticket-to-pr` | Asks you |

All three share one rule set, including one UI gate (`reference/delivery-rules.md` in each skill). `/ship-plan` was removed in 0.7.0; use `/implement-to-pr --review-plan --merge`.

| Skill | What it does | Needs |
|---|---|---|
| **implement-to-pr** | Implements a task with subagents, opens the PR, fixes review findings until clean, and runs the UI gate for UI changes. `--review-plan` reviews and improves the plan first; `--merge` merges once green. Works without a GitHub remote. | `code-review`; `ui-critique-loop` for UI |
| **finish-pr** | Updates a PR from main, lists the remaining work, implements it, and reviews twice, with the UI gate for UI changes. | `code-review`; `ui-critique-loop` for UI |
| **ticket-to-pr** | Takes one Jira or GitHub ticket to a reviewed PR in a worktree and moves it through the tracker. | `code-review`; Atlassian MCP for Jira |
| **ticket-triage** | Finds untriaged tickets, analyzes each against the code, comments and labels it, and offers act or skip. | Atlassian MCP for Jira |
| **issues-to-plan** | Turns an issue list into a verified, reviewed implementation plan, sequenced into PRs. Plan only. | — |
| **combine-prs** | Folds several PRs into one integration PR using parallel subagents. Never touches the source branches. | — |
| **drain-pr-queue** † | Merges every green, mergeable PR one at a time, and updates conflicting ones, until none are left. | — |

### Design UI (power-tools-ui)

The first three run real `/impeccable` commands for every design step, and add scoring gates,
persona reviews and stopping rules around them. `ux-mockup` takes Impeccable's recommended
options itself; `ui-finalize` stops and asks you to pick its one bold enhancement.
`screenreader` and `video` don't use Impeccable. `screenreader` tests with NVDA and runs on
Windows only. `video` makes an MP4 with [Remotion](https://www.remotion.dev), which is free for
individuals and companies of up to 3 people; larger companies need a Remotion company license.

| Skill | What it does | Needs |
|---|---|---|
| **ux-mockup** | Writes a UX plan backed by an interactive HTML mockup, iterated until its scores pass. Never changes product code. | `impeccable`, `ui-critique-loop` |
| **ui-critique-loop** | Critiques, fixes and blindly re-scores a UI until its design score (out of 40) beats a threshold. | `impeccable` |
| **ui-finalize** | Finishes a UI for release: score gate, one bold enhancement, harden, polish, and a final critique. | `impeccable`, `ui-critique-loop` |
| **screenreader** | A vision-impaired persona does a task on a web page with NVDA's keys and speech only, never the screen. You get a report of every barrier, quoting what NVDA said. Sets up NVDA and its MCP server first. | Windows; NVDA 2026.3+, the [NVDA MCP](https://github.com/InfiArtt/nvda-mcp) add-on and uv, which it installs |
| **video** | Makes the video you describe: a storyboard, Remotion compositions (three.js for 3D), rendered stills it looks at and fixes, then the MP4. Picks the length, size and folder itself unless you say. | Node 20+, npm; downloads Remotion and a headless Chrome into the video's folder |

### Start and ship projects (power-tools-projects)

| Skill | What it does | Needs |
|---|---|---|
| **new-project** | Takes an empty folder to a running app: repo, your vision, a plan, a mockup, the build and a review. Desktop, mobile and web via Tauri 2, or web only. Resumable. | `project`, `ux-mockup`, `implement-to-pr`; `npm create`, Rust for Tauri, Docker for a database |
| **project** | Remembers your project folders, each project's stage, and finds repos you haven't registered. | — |
| **deploy** † | Publishes a splash page to GitHub Pages and the app to Cloudflare Pages, Fly.io, your own server, or GitHub Releases (Tauri installers), through GitHub Actions. Asks before anything goes live; you set secrets yourself. | `project`, `impeccable`, `ui-critique-loop` |

### Maintain (power-tools)

| Skill | What it does | Needs |
|---|---|---|
| **update** † | Shows what a newer version would change; `--force` applies it. Ends with a check that every hook runs. | gh |
| **git-guard** † | Shows the git-guard rules, tests a command against them, switches one off for a repo, and turns on the opt-in merge gate. | — |

### Bundled and companion skills

Two third-party skills ship unmodified (see [THIRD_PARTY.md](THIRD_PARTY.md)). Impeccable comes
with **power-tools-ui**; graphify is installer-only (`--with graphify`), because its description
claims every question about a codebase:

| Skill | What it does | Version · License |
|---|---|---|
| **impeccable** | Designs, critiques, audits, polishes and hardens frontend UI (`/impeccable critique`, `/impeccable polish`, ...). Downloads its native engine on first use, checksum-verified. | 4.8.0 · Apache-2.0 |
| **graphify** | Turns a codebase, docs or media into a queryable knowledge graph. Needs its Python CLI: `uv tool install graphifyy` (or `pipx install graphifyy`). | 0.9.97 · Apache-2.0 |

`code-review` and `loop` come with Claude Code, as do `ListAgents` and `SendMessage`, which the
coordination skills use to talk to peers.

## Hooks

A hook is a script Claude Code runs on an event, such as a command or the start of a session.
These run on their own once installed. If one errors, your command still runs.

- **git-guard** blocks `--no-verify`, force-push, committing on a shared `main`, switching
  branches over another session's uncommitted files, and deleting a folder through a link. Each
  denial names the safe alternative.
- **Merge gate** (opt-in, `/git-guard enable merge-gate`): Claude merges a PR only after you
  send `approve merge #N` as the first line of a message, and only once its checks are green.
- **usage-handoff** reads your usage on each prompt and tool call, from a cache shared by every
  session (refreshed every 1 to 10 minutes, faster near the limit). Near 95% it tells each session
  and subagent once to write its handoff and stop. Silent otherwise; `/usage-handoff off` turns
  it off.
- **Hook doctor** speaks up at session start only when an installed hook is broken.
- **Session start** notes list pending inbox requests and the next `/new-project` step.
- **fleet-manager debounce** skips `/fleet-manager` passes that ran minutes ago or would find
  nothing new.

Events, details and the exact settings the installer writes: [docs/hooks.md](docs/hooks.md).

## Configuration

Nothing to set up. Every enhancement starts on and has a switch:

- **Remote Control in every new session:** a core install (a plain installer run, `--all`, or
  `/update` of one) sets `remoteControlAtStartup: true` in `settings.json`. That's the same
  switch as `/config`'s "Enable Remote Control for all sessions". It does this only when
  `settings.json` doesn't set it yet, so your own choice stays. `--no-remote-control` stores
  `false`. A plugin install leaves it to `/config`.
- **The status line's parts:** `/show-model`, `/show-email` and `/show-usage`.
- **The usage hook:** `/usage-handoff off`.

Per-repo settings (tracker, push command, PR title format, merge method) go in
a `## Power tools` section of the repo's `CLAUDE.md` or `AGENTS.md`; see
[docs/configuration.md](docs/configuration.md). On Windows, read
[docs/windows.md](docs/windows.md) for PowerShell 5.1 quirks that look like real failures.

## Development

```sh
npm test
```

Runs every suite and repo check. Evals, shared files and vendoring are covered in
[docs/development.md](docs/development.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR, and [CHANGELOG.md](CHANGELOG.md) for
what changed in each version.

## License

[Apache License 2.0](LICENSE). The bundled Impeccable and graphify skills keep their own licenses;
see [THIRD_PARTY.md](THIRD_PARTY.md).
