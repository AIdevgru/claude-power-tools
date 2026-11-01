---
name: ui-finalize
description: "Take an existing UI to release quality: the ui-critique-loop score gate, an overdrive pass where the owner picks the direction, then Impeccable harden, polish and a blinded final critique. Trigger on '/ui-finalize', 'finalize this page for release', or 'harden and polish this UI'."
user-invocable: true
disable-model-invocation: false
argument-hint: "[--score N] [--no-overdrive] <page, route, component, URL or flow>"
---

# UI finalize

Finish an existing interface for release in one fixed order:

`ui-critique-loop -> overdrive (the owner picks) -> harden -> polish -> final critique`

This is a release-candidate pass with an end, not a reason to keep touching the UI.

## Arguments

`/ui-finalize [--score N] [--no-overdrive] <target>`

- `--score N` (or `--score=N`) sets the threshold. The default is 38. Give it at most once. N must be a whole number from 0 to 39. For a missing, repeated, non-integer or out-of-range value, stop with `Invalid --score: use an integer from 0 through 39.`
- The pass mark is strictly above the threshold: threshold + 1 out of 40, so 39/40 at the default.
- `--no-overdrive`, at most once, skips phase 2.
- The old single-dash forms `-score N` and `-no-overdrive` are still accepted until 0.7.0.
- Remove the flags; the rest is one stable target.

## Rules

1. **Run every phase through a real skill call:** `/ui-critique-loop` for phase 1, and the `impeccable` skill for the rest. Invoke it with the Skill tool and `args: "<command> <target>"`, written here as `/impeccable <command> <target>`. Under the plugin the names are `power-tools-ui:impeccable` and `power-tools-ui:ui-critique-loop`. Never do a phase from memory or by reading its reference alone: invoking the skill runs its context setup, loads the command's reference and its craft rules, and uses its detector. Subagents that edit UI invoke it the same way. If `impeccable` doesn't resolve, stop with `Blocked before final verification: the impeccable skill is not installed`.
2. Look at the target and at least one representative source of its current visual truth (the design system, `DESIGN.md`, or a neighbouring screen).
3. Invoking this skill is permission to use every subagent both critique runs need. Don't ask again.
4. Preserve product truth, permissions, accessibility, responsive behavior, data behavior, the design system's identity, and everything outside the target.
5. Follow the repo's `AGENTS.md` and `CLAUDE.md` and every matching framework, testing, security or deployment skill. This workflow never bypasses their gates.
6. Finishing locally isn't releasing. Never claim something is live without the repo's deployment evidence.

## Phase 1: a verified foundation

Run `/ui-critique-loop --score <threshold> <target>`. That skill owns its blinded scoring, its fix cycles, browser evidence, saved snapshots, tests and its final adversarial scorer.

Continue only when it reports a verified score above the threshold, out of 40, with zero open P0/P1 issues, no unapproved detector finding, and passing required tests.

If it stops below the threshold, could only produce an unverified (degraded) score, reports a maximum other than 40, or is blocked, stop here with the same truthful outcome. Don't use overdrive to cover weak fundamentals.

## Phase 2: one ambitious enhancement (the owner picks)

Skip this phase only with `--no-overdrive`.

Run `/impeccable overdrive <target>`. This phase doesn't let you choose the direction for the owner:

1. Propose 2–3 directions specific to the target, each with its trade-offs in performance, complexity, browser support and maintenance.
2. Include `Skip overdrive` when no enhancement would really improve the experience.
3. Stop and ask the owner to choose (with `AskUserQuestion`) before editing anything.
4. Build the one chosen direction, once. Never layer several competing showpieces.
5. Keep progressive enhancement, working fallbacks, reduced-motion behavior and performance on mid-range devices.

For functional product screens (dashboards, forms, workflows), prefer exceptional fluency, responsiveness, state transitions, bulk efficiency and perceived speed over marketing spectacle. Don't add backend capabilities or change product scope in the name of overdrive.

Never run overdrive again on your own. A second overdrive pass always needs another explicit choice from the owner.

## Phase 3: harden what now exists

Run `/impeccable harden <target>` once, after overdrive, so its new behavior is covered too.

Test and fix the whole path for:
- long, empty, missing, localized, right-to-left, CJK and emoji content;
- loading, offline, timeout, validation, API, permission, rate-limit and recovery states;
- double submission, races, concurrency, large datasets and interrupted flows;
- keyboard, screen-reader, zoom, high-contrast, touch and supported-browser behavior;
- overdrive fallbacks, reduced motion, cleanup, latency and resource use.

Add or update automated tests in proportion. Run the narrowest relevant tests first, then the repo's required gates.

## Phase 4: polish last

Run `/impeccable polish <target>` once, after hardening. The order matters: harden hands the finished path to polish, and polish has to see every state and fallback the earlier phases added.

Use the latest critique snapshot as one input, then look at the current rendered page and the source diff yourself. Fix design-system drift, hierarchy, responsive behavior, typography, colour, interaction states, accessibility details, inconsistent copy, accidental churn, dead code and leftover temporary files.

Polish refines. Don't redesign the target or undo the chosen overdrive direction.

## One shared check for phases 2–4

Treat overdrive, harden and polish as one implementation cycle, not three loops:
- Gather desktop and mobile evidence together.
- Batch every defect you see into one correction pass.
- Confirm visually at most once.
- Reuse browser, detector and test evidence across phases while it's still current.
- Leave acceptance to the final critique, and don't turn its browser pass into another open-ended polish loop.

## Phase 5: the final independent critique

Run a fresh, standard `/impeccable critique <target>`, not another `ui-critique-loop` run.

Use new, isolated Assessment A and B subagents (A scores the design against the rubric; B runs the detector and gathers browser evidence). Don't tell them the threshold, the baseline score, the chosen overdrive direction, earlier findings or what was fixed. Save the final snapshot and trend as the critique reference requires.

When the critique asks what to improve next, record:

`Questions skipped: ui-finalize uses this critique as an acceptance gate and routes only evidence-backed failures.`

Accept only when:
- the final score is at least threshold + 1 out of 40;
- no P0/P1 issue remains;
- every detector finding is resolved, on the approved ignore list, or documented as a false positive;
- the required behavior, accessibility, responsive, performance and repo tests pass; and
- temporary browser sessions, servers and report files are cleaned up.

## One targeted recovery, never a loop

If the final critique fails, choose exactly one recovery command from its evidence:
- `/impeccable harden` for missing states, recovery, inputs, i18n, concurrency, performance resilience or fallback failures.
- `/impeccable polish` for hierarchy, consistency, responsive layout, interaction detail, accessibility presentation, copy or design-system drift.
- `/impeccable overdrive` only when the remaining problem is truly about ambition or the product-specific experience, and only after the owner chooses a direction again.

Run that one command once, re-run the affected tests, then run one last fresh standard critique. Never re-run all three commands, never average scores, and never start another recovery on your own.

If the second final critique still fails, stop and report the verified score, the trend, the remaining evidence, test status and the smallest next step. Don't claim the UI is finalized.

## Report

Start with exactly one of these lines:

- `Finalized and verified above <threshold>: <score>/40`
- `Not finalized: <score>/40 after one targeted recovery`
- `Threshold not comparable: applicable maximum is <n>, not 40`
- `Blocked before final verification: <reason>`

Then report the target, whether overdrive ran and which direction the owner chose, the critique trend, the changes that mattered most in each phase, files changed, tests and repo gates, detector and browser evidence, snapshot paths, remaining risks, and deployment status.
