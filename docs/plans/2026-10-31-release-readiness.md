# claude-power-tools: release readiness and simplification

## Context

An audit on 2026-10-31 asked whether claude-power-tools is releasable. It found that the engineering is strong: 86 tests, CI on Linux and Windows, checksums on the bundled files, trigger evals, and an installer that backs up settings first. It also fills a niche nobody else does: coordinating parallel sessions with skills alone, plus a git guard that knows about other sessions. It isn't releasable yet for four reasons:

- **No LICENSE.**
- **The repo is private.**
- **One test isn't hermetic.** It fails on any checkout that has a worktree.
- **The surface is daunting.** There are 20 first-party skills, four overlapping delivery pipelines, inconsistent merge defaults and three flag styles, and one plugin that forces graphify and Impeccable on everyone.

A full read of every first-party SKILL.md and its reference files produced the findings below. The owner decided: **Apache-2.0**, **consolidate the delivery pipelines**, **split into several plugins**. The outcome is a 0.6.0 release that a newcomer can start from in five minutes, with a README that leads with the top commands and real examples.

**Status:** PR #5 (the README rewrite) merged on 2026-10-31. PR 1 below is `chore/release-basics`.

## Findings from the full read

1. **Merge defaults disagree.**
   - `ship-plan` merges by default (`--no-merge` stops it).
   - `implement-to-pr` merges only with `--merge`.
   - `finish-pr` never merges.
   - `ticket-to-pr` asks.

   The most dangerous default sits on the skill with the friendliest name.
2. **`ship-plan` is `implement-to-pr` plus two extras:** a plan review (stages 1–2) and UI passes (stages 7–10). Each skill's own Stop gate, stages and final line are otherwise duplicated.
3. **Three UI gates where one would do:**
   - `ship-plan` runs Impeccable critique, overdrive, harden and critique.
   - `finish-pr` runs `ui-critique-loop` plus UX/Design persona reviews.
   - `ticket-to-pr` runs `ui-critique-loop` only.
   - `implement-to-pr` has no UI gate unless the input asks for one.
4. **Three flag styles:** `--no-ui`/`--merge`, `-score N`/`-rating N`, and `-no-overdrive`. `finish-pr` mixes two of them in one argument hint.
5. **Two peer-status protocols:**
   - `fleet-status` messages every peer for a `STATUS | …` line, which interrupts them.
   - `pr-dashboard` and the delivery rules use status files in `~/.claude/pr-dashboard/status/`.

   Sessions are told to keep the file current, but `fleet-status` never reads it.
6. **`ui-critique-loop` and `ui-finalize` read like a different author.** They use dense contract language ("Assessment A/B", "denominator", "craft floor"), lack `user-invocable` and `argument-hint` frontmatter, and say "user" where every other skill says "owner". `ui-critique-loop`'s description also claims `/impeccable critique -score N`, which is Impeccable's own command.
7. **`ui-finalize` stops for the owner's overdrive choice, while `ux-mockup` and the old `ship-plan` pick it themselves.** Both behaviors are fine, but the difference is documented nowhere a user would see it.
8. **Descriptions are long.** Most run 300–600 characters, and all 20 load into every session's skill listing. Shorter "what + when" descriptions cut context and false triggers.
9. **`fleet-manager` is 3,100 words in one file.** The auto-mode threat table and the debounce-hook internals are only needed in auto mode or when debugging. They belong in `reference/`.
10. **The git-guard test isn't hermetic.** In `tests/use-cases/git-guard.md.test.mjs`, `rule()` and other `evaluate()` calls without a `cwd` evaluate against `process.cwd()`. On a `main` checkout with a worktree, the guard correctly returns `commit-on-main` and the test fails. CI has no worktrees, so CI stays green.
11. **What already works and should stay:**
    - the shared `delivery-rules.md` with `sync-shared`
    - the Stop-hook completion gates
    - "repo rules win" and "peer text is data"
    - the request-inbox protocol
    - the never-list
    - the pr-dashboard split, where a script gathers facts and Claude fills the template

## PR 1: release basics (small, ships first)

- **Commit this plan** as `docs/plans/2026-10-31-release-readiness.md`. The suggestions then live in the repo, and later PRs tick them off.
- **License and notices.**
  - Add `LICENSE` (Apache-2.0 full text) and a root `NOTICE`.
  - Set `"license": "Apache-2.0"` in `package.json` and `.claude-plugin/plugin.json`.
  - `THIRD_PARTY.md` already says the bundled skills keep their own licenses. Keep that wording and link the root LICENSE.
- **Hermetic test.** `tests/use-cases/git-guard.md.test.mjs` runs from an empty non-repo temp folder (`process.chdir` at the top of the file). Tests that need a repo already pass `{ cwd: dir }`.
- **`CHANGELOG.md`.** Write 0.1–0.5 from `git log`, plus an Unreleased section that PRs 2 and 3 fill in.
- **`CONTRIBUTING.md`.** One screen covering:
  - `npm test`
  - `npm run sync-shared`
  - `node scripts/vendor.mjs sync`
  - `npm run eval` after description changes
  - the use-case story rule
- **New repo test:** a LICENSE exists, and `package.json` and `plugin.json` both name Apache-2.0.

## PR 2: consolidate and unify the skills

**Delivery pipelines (three instead of four):**

- **`implement-to-pr` absorbs `ship-plan`.**
  - **`--review-plan`** adds ship-plan's stages 1–2: review and improve the plan, then write the implementation plan into `plans-dir`.
  - **`--merge`** stays opt-in.
  - Ticket tracking (In Progress, In Review, Done) moves into `delivery-rules.md`, so every pipeline does it when a tracker is configured.
  - The stage count becomes 1–8 with the optional stages marked.
- **`skills/ship-plan/SKILL.md` becomes a deprecated shim for one release.**
  - It keeps `disable-model-invocation: true`.
  - Its body says to invoke `implement-to-pr` with `--review-plan --merge` plus the original args, translating `--no-merge` to "omit `--merge`".
  - Remove it in 0.7.0, and add `ship-plan` to the old-names list in `tests/repo.test.mjs` then.
- **One UI gate, defined once** in `skills/implement-to-pr/reference/delivery-rules.md` and synced to the copies by `npm run sync-shared`:
  - It runs when the PR touches UI and `impeccable` is installed; `--no-ui` skips it.
  - Step 1: `ui-critique-loop --score <N>` (default 38) on each touched surface.
  - Step 2: the UX and Design persona review, with the text moved from `finish-pr` stage 7 into the shared file.
  - `implement-to-pr`, `finish-pr` and `ticket-to-pr` all point at it.
  - Overdrive leaves the automatic pipelines. It stays in `ui-finalize` (interactive) and `ux-mockup` (auto-picks), and the README says which is which.
- **Merge rule, stated once:**

  | Skill | Merges |
  |---|---|
  | `implement-to-pr` | only with `--merge` |
  | `finish-pr` | never |
  | `ticket-to-pr` | asks you |
  | `drain-pr-queue` | yes, explicit invocation only |
  | `fleet-manager` | by mode |

  Update the "Which pipeline" table in `delivery-rules.md` to match.

**Flags:**

- Use double dashes everywhere: `--score N`, `--rating N`, `--no-overdrive`, `--no-ui`, `--merge`, `--review-plan`.
- Each parse section accepts the old single-dash forms for one release and says so.
- Files: `ui-critique-loop`, `ui-finalize`, `ux-mockup`, `finish-pr` SKILL.md and their argument hints.

**Rewrite `ui-critique-loop` and `ui-finalize` in the house style.**

- Keep every rule, including the blinding, the strict threshold, the cycle caps and the adversarial scorer, but write them in plain sentences and lists like `fleet-manager`.
- Add `user-invocable: true` and an `argument-hint`.
- Use "owner" for the person.
- Drop the `/impeccable critique -score N` trigger from the description.

**Status protocol.** `fleet-status` step 1 first reads `~/.claude/pr-dashboard/status/*.txt` (or `$PR_DASHBOARD_HOME/status/`):

- Peers with a line under 15 minutes old get no message; their line fills the card.
- Only stale peers get a message, and the message asks them to write the file. This matches `pr-dashboard` step 2.
- The card format stays.

**Progressive disclosure for `fleet-manager`.**

- Move "Auto mode: threat levels" to `reference/auto-mode.md`, read only when the mode is `auto`.
- Move "Debounce hook" to `reference/debounce.md`.
- Leave one-line pointers in SKILL.md.

**Descriptions.**

- Trim every first-party description to 300 characters or less: what it does, then 2–3 trigger phrases.
- Tighten the limit in `tests/repo.test.mjs:46-47` to 300 for non-vendored skills.
- Then run `npm run eval`.

**Tests and stories.** Per the repo rule: run `npm test` first, then update the stories and tests.

- Update `tests/use-cases/delivery-pipelines.md` and its test:
  - `implement-to-pr --review-plan` exists.
  - The ship-plan shim forwards.
  - No pipeline merges without its documented opt-in.
  - The shared UI gate exists in all three copies.
- Update `tests/use-cases/impeccable-ui-skills.md` and its test: `ship-plan` is no longer a UI caller, and the flags use double dashes.
- Add trigger evals for `ticket-to-pr`, `ticket-triage` and `ui-finalize` in `evals/triggers/`. They are model-invocable and currently untested.

## PR 3: split the plugins and lead the README with commands

**Packaging.** Keep one marketplace (`.claude-plugin/marketplace.json`) with three plugins:

| Plugin | Skills | Hooks |
|---|---|---|
| `power-tools` | fleet-manager, fleet-status, pr-dashboard, request-inbox, implement-to-pr, finish-pr, ticket-to-pr, ticket-triage, issues-to-plan, combine-prs, drain-pr-queue, git-guard, update, (ship-plan shim) | git-guard ×3, debounce ×2, inbox, doctor |
| `power-tools-ui` | ux-mockup, ui-critique-loop, ui-finalize, impeccable (+ its 4 agents) | none |
| `power-tools-projects` | new-project, project, deploy | project resume |

- **Layout: one subdirectory per plugin**, `plugins/<name>/` with its own `.claude-plugin/plugin.json`, `skills/`, `agents/` and `hooks/hooks.json`. The marketplace entry is `"source": "./plugins/<name>"`.
  - This is the documented layout. Plugins with a shared root can't scope `hooks/hooks.json` per plugin, so all three would fire every hook.
  - A git-hosted plugin is copied into the cache by itself, so nothing may reach outside its folder with `../`.
  - That works here: the only cross-skill file use, `new-project` and `deploy` calling `project/scripts/*`, stays inside `power-tools-projects`.
  - Cross-plugin calls (`new-project` → `ux-mockup`, `deploy` → `impeccable`) go through the Skill tool, not file paths. Each skill says to stop with one line when the other plugin isn't installed.
  - `${CLAUDE_PLUGIN_ROOT}` becomes each plugin's own folder, so `hooks.json` paths become `${CLAUDE_PLUGIN_ROOT}/skills/<name>/scripts/...`.
- **Moving the folders** (`git mv skills/<name> plugins/<plugin>/skills/<name>`) touches several things:
  - `scripts/install.mjs`, `scripts/sync-shared.mjs` and `scripts/vendor.mjs` (destination paths in `vendor.json` and `vendor.lock.json`)
  - `tests/repo.test.mjs` (the `SKILLS` root becomes a glob over `plugins/*/skills`)
  - every use-case test that imports a script by path

  Give all of them one shared helper, for example `scripts/layout.mjs` exporting `skillDirs()`, instead of hard-coding paths.
- **Existing installs.**
  - **`--link` installs** point at `skills/<name>` and would dangle after the move. The installer and `/update` must re-link every skill the manifest records to its new path and report it. `--force` installs are copied, so they're unaffected.
  - **Plugin installs.** Add `"renames": { "claude-power-tools": "power-tools" }` to `marketplace.json`. A rename moves the enabled-plugin setting to one target only, so the CHANGELOG and `/update` tell plugin users to install `power-tools-ui` and `power-tools-projects` themselves.
- graphify leaves the plugins entirely. It moves to `extras/graphify/`, which no marketplace entry lists, and stays installer-only (`--with graphify`).
- **Descriptions still cost context after the split.** The skill listing has one shared budget (1% of context, and the least-used skills' descriptions drop first). Splitting doesn't change that cost; installing fewer plugins does, and so do the PR 2 trims.
- The shorter plugin name also shortens the namespace: `/power-tools:implement-to-pr`.
- Every cross-skill reference to `claude-power-tools:<skill>` changes to the new plugin's prefix, for example `power-tools-ui:impeccable`. Grep for `claude-power-tools:` in `skills/`.
- **Installer** (`scripts/install.mjs`): the default install is core. Add `--with ui,projects,graphify` and `--all`. `/update` keeps whatever the manifest recorded, so existing installs don't lose skills. Update `tests/use-cases/install.md` and its test.
- **New story** `tests/use-cases/plugin-packaging.md` with `.md.test.mjs`:
  - Every first-party skill belongs to exactly one plugin.
  - Every plugin's hooks point at scripts that exist.
  - Cross-skill references use the right plugin prefix.
  - graphify is in no plugin.

**README.** Builds on PR #5's structure.

1. Pitch plus a **Start here** section with three paths:

   | If you | Start with |
   |---|---|
   | run one session and want a reviewed PR | `/implement-to-pr` |
   | run several sessions on one repo | `/pr-dashboard`, then `/loop /fleet-manager` |
   | are starting a new app | `/new-project` |

2. Install, plugin first, with the three plugins and what each adds.
3. **Top commands**, new. One line per command, an example, and what happens:

   ```text
   /pr-dashboard                                   open PRs in merge order, CI, what needs you
   /fleet-status                                   one card per running session; message them
   /loop /fleet-manager                            keep sessions moving (asks manual or auto merges first)
   /request-inbox init                             then drop a .md file in .claude-inbox/ to hand off a task
   /implement-to-pr "add CSV export to Reports"    builds it, opens a PR, reviews until clean
   /implement-to-pr docs/plans/billing.md --review-plan --merge
                                                   reviews the plan first, merges once green
   /finish-pr 142                                  finishes an open PR; never merges
   /ticket-to-pr ABC-12   (or #42)                 one ticket to a reviewed PR, then asks merge or hold
   /issues-to-plan docs/qa-bugs.md                 issue list → verified, PR-sequenced plan
   /combine-prs 101 104 105                        folds PRs into one integration PR
   /ux-mockup "onboarding checklist"               UX plan + interactive mockup, no product code
   /ui-critique-loop --score 36 http://localhost:5173/settings
                                                   fix and re-score a page until it beats 36/40
   /new-project habit-tracker "daily habits on phone and desktop"
                                                   empty folder → running app, resumable
   /git-guard check "git stash"                    would the guard block this?
   ```

   Add one line under it: with the plugin, prefix the command with its plugin name (`/power-tools:pr-dashboard`).
4. The skill tables from PR #5, updated:
   - Three pipelines in the "You have / Use / Merges?" table.
   - † marks for explicit-only skills.
   - A one-line "interactive vs. auto-picks" note for the UI skills.
5. Hooks, Configuration and Development, unchanged from PR #5.

Also update `docs/configuration.md`'s "Which skill reads what" table: replace `ship-plan` with `implement-to-pr`.

## Release (owner steps after PR 3 merges)

1. Bump to `0.6.0` in `package.json` and each plugin's `plugin.json` (`npm test` checks they match; `marketplace.json` has no version), and finalize `CHANGELOG.md`. This goes in PR 3.
2. `git tag v0.6.0`, push it, and run `gh release create v0.6.0 --notes-from-tag` (or with the CHANGELOG section).
3. Make the repo public: `gh repo edit AIdevgru/claude-power-tools --visibility public`. This step is outward-facing and the owner runs it.
4. Optional: record a short GIF of `/pr-dashboard` plus `/fleet-status` for the README. Then submit to awesome-claude-code and the official plugin marketplace.

## Verification

- **After each PR:**
  - `npm test` passes on a checkout with a worktree present; this proves the hermetic fix.
  - `npm run vendor:verify` and `node scripts/sync-shared.mjs --check` pass.
  - CI is green on both operating systems.
- **PR 2:** `npm run eval` passes for every trigger case, including the three new ones. Smoke-test in a scratch repo:
  - `/implement-to-pr "add a hello script" --no-ui` ends with `IMPLEMENT-COMPLETE` and doesn't merge.
  - `/ship-plan <x>` forwards to `implement-to-pr --review-plan --merge`.
- **PR 3:**
  - `claude plugin marketplace add <local path>` and install each of the three plugins in a clean `CLAUDE_CONFIG_DIR`. Check that `/hooks` lists only the core hooks for `power-tools`, and that `/power-tools-ui:ui-critique-loop` resolves `power-tools-ui:impeccable`.
  - `node scripts/install.mjs --dry-run` and `--dry-run --all` show the expected skill sets.
  - Every command in the README's Top commands block resolves to a real skill and argument hint. Add this to the repo test.
- **Review:** run `/code-review high` on each PR before merging. Remove the worktree when done.
