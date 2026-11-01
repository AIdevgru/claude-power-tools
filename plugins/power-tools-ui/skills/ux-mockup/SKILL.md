---
name: ux-mockup
description: "Write a UX plan for a feature, backed by an interactive HTML mockup that Impeccable builds and ui-critique-loop plus UX and Design personas iterate until highly rated. Auto-picks recommended options; never edits product code. Trigger on '/ux-mockup', 'mock up <feature>', or 'UX plan with a mockup'."
user-invocable: true
disable-model-invocation: false
argument-hint: "<feature> [--score N] [--rating N]"
---

# UX mockup

Write a plan to improve the UX of the feature **`$ARGUMENTS`**. Back the plan with an interactive mockup that a UX persona and a Designer persona have iterated until it is highly rated.

The deliverables are the mockup and the plan. **This skill never changes product code, opens a PR, merges or deploys.**

**Requires** the third-party `impeccable` skill (and this repo's `ui-critique-loop`). If `impeccable` isn't installed, say so in one line and stop.

## Arguments and defaults

- **Feature:** the non-flag words of `$ARGUMENTS`.
  - If the feature is empty, ask once which one, then proceed.
  - Map the name the user gives to its routes, components and modules in the codebase. If the codebase uses a different name for it, say so in one line.
- **`--score N`:** the critique threshold, default **38**. The score must be **above** N (39/40 or better at the default).
- **`--rating N`:** the minimum persona rating, default **9**, on a 1–10 scale.
- The old single-dash forms `-score N` and `-rating N` are still accepted until 0.7.0.
- **Round cap:** at most **5** persona rounds and **5** critique rounds. If a cap is hit, stop, report the best version and its scores, and list the remaining findings. Never loop forever.

## Accepting all recommendations

Invoking this skill pre-approves every recommendation. Some Impeccable commands would normally stop and ask: the `shape` discovery interview, the `overdrive` "propose before building" pick, and any "Recommended" option. At each of those gates:
1. Work out the options as the command describes.
2. **Pick the recommended option yourself.** If none is marked, pick the one most consistent with the project's product and design docs (such as `PRODUCT.md` and `DESIGN.md`) and the existing UI.
3. Record the question, the options and your pick in the **Decisions log** of the plan.
4. Continue without calling `AskUserQuestion`.

Only stop for something the owner must decide that has no defensible default: a legal or compliance trade-off, real money, or anything that would ship to production. This should be rare for a mockup.

## Ground rules

- **Repo rules win.** Read the project's agent instructions (`CLAUDE.md`, `AGENTS.md`) and its product and design docs, and follow them: branch or worktree isolation, timestamp and naming conventions, UI elements the project requires on every page, and its supported languages and locales.
- **Synthetic data only.** Fill the mockup with invented people, records and content. Never use customer data, production databases, uploads or screenshots of unknown provenance.
- **Run Impeccable, don't imitate it.** Every design step is a real `/impeccable <command> <target>` call (see below). Use `ui-critique-loop` for scoring. Its blinded assessors decide the score; never score it yourself.
- **Subagents do the work; you orchestrate.** Give one writer per file. Brief each subagent fully: the feature, the mockup path, the brief, the current findings, and the rules above.
- **The mockup's form.** A single self-contained HTML file (inline CSS/JS, no build step) at `docs/design/<feature-slug>/mockup/index.html`, or the project's equivalent design folder.
  - It must be **interactive**: real navigation between states, working inputs, open/close, and the empty, loading, error, success and permission-denied states.
  - It covers every user role that sees the feature, taken from the project's own role or permission model.
  - Colour tokens on `:root`, a dark mode, a phone-width layout with no horizontal scroll, and pinned CDN versions only. If the `artifact-design` skill is available, follow its page contract.
  - Serve it locally (for example `python -m http.server` from its folder) so the critique and browser tools can open it.

## Running Impeccable

Run each design step as `/impeccable <command> <target>`: invoke the `impeccable` skill with the Skill tool and `args: "<command> <target>"`. Under the plugin the names are `power-tools-ui:impeccable` and `power-tools-ui:ui-critique-loop`. Don't do a command from memory or by reading its reference file alone: invoking the skill runs its context setup, loads the command's reference and its craft floor, and uses its detector. Subagents that do design work invoke it the same way, and their brief says so. Answer the command's questions as in "Accepting all recommendations" above.

## Stages

Report one line per stage (`Stage 3/9 done: ...`) and nothing more until the end.

1. **Ground the current feature.**
   - Read the feature's routes, components and copy, and any existing design docs or mockups for it.
   - Capture screenshots of the live feature where browser tools and a local dev server are available. Otherwise describe the screens from code.
   - List current pain points with `path:line` evidence, plus the roles and contexts the feature serves.

2. **`/impeccable shape <feature>`.** Run shape on the feature. Answer its discovery interview by accepting the recommendations (see above), anchored on the project's product and design docs and on stage 1. Produce the design brief and save it into the plan.

3. **Build mockup v1.** A subagent runs `/impeccable` with the brief and the mockup path as a new-work request (for example `args: "build the interactive mockup at <path> from this brief: ..."`), then you open it in the browser and confirm every state is reachable.

4. **`/impeccable layout <mockup>`.** Fix spacing, rhythm and visual hierarchy across every state and both colour schemes, at phone and desktop widths.

5. **`/impeccable harden <mockup>`.** Cover long and empty content, errors, offline and slow states, i18n for the project's supported languages, keyboard and screen-reader paths, focus order, and reduced motion.

6. **`/impeccable overdrive <mockup>`.** Work out 2–3 directions as the reference describes, pick the recommended one, log it, and build it into the mockup. Match the ambition to the surface: functional product UI gets instant, optimistic, animated state transitions rather than spectacle.

7. **Critique until the score is above the threshold.**
   - Invoke `ui-critique-loop` with `--score <N> <mockup URL>`.
   - Subagents apply the remediations, and the skill re-scores. Repeat until the verified score is above N or the round cap is hit.

8. **UX and Designer personas iterate.**
   - **Spawn the reviewers.** Spawn two reviewer subagents in parallel each round, one per persona, against the current mockup. If the user or repo has persona files for UX or Design, load them. Otherwise use these briefs:
     - **UX persona (senior UX researcher and interaction designer):** task completion and flow friction, information architecture, wayfinding, the empty/loading/error states, forms and validation, role differences, accessibility, mobile behaviour and UX copy.
     - **Designer persona (senior product and visual designer):** fit with the project's design system and neighbouring screens, visual hierarchy, typography, spacing, colour and contrast, motion and polish.
   - **What each reviewer returns:** a **rating from 1 to 10**, the single change that would raise it most, and findings with severity, location and a concrete fix. Ask them to use screenshots.
   - **Apply the fixes.** Implementation subagents apply the verified findings through the Impeccable command that owns each one (`/impeccable layout`, `clarify`, `typeset`, `adapt`, `polish`, ...), with one writer per file. Each persona also sees the other's previous rating and findings, so the two converge rather than pull apart.
   - **When to stop:** both ratings are at least `--rating` **and** the critique score is still above N. If the round's changes were material, re-run stage 7's critique once to confirm. Otherwise, repeat until the round cap.

9. **Publish and write the plan.**
   - **Publish the mockup** privately if the session can (for example with the `Artifact` tool, loading `artifact-design` first). Keep the local file as the source.
   - **Write the plan** to `docs/plans/<YYYY-MM-DD>-<feature-slug>-ux.md`, or the project's plans folder, using the UTC date. Its sections:
     - **Goal and summary:** the problems and the outcome in one paragraph.
     - **Current state:** the stage 1 pain points with `path:line` evidence.
     - **Design brief:** from shape.
     - **Mockup:** the published link (if any), the local path, and the states and roles it covers.
     - **Changes by surface:** for each route or component, what changes and why, mapped to the mockup state that shows it.
     - **Decisions log:** every auto-accepted recommendation (stage gate, question, options, pick).
     - **Scores:** the critique score per round, the persona ratings per round, and the final values.
     - **Implementation sequence:** small PRs in merge order. Each lists its files, its tests, and whatever else the project's rules require per change (stories, specs, parity checks, threat models).
     - **Risks and open questions:** anything left for the owner.

## Final report

Keep it short:
- the mockup link (if published) and the plan path written in full
- the final critique score, the final UX and Designer ratings, and the number of rounds used
- the 3–5 biggest UX changes the plan proposes
- the number of auto-accepted decisions, plus any you could not default and stopped on
- anything left for the owner
