---
name: ui-critique-loop
description: "Critique, fix and blindly re-score a UI with Impeccable until its design score out of 40 beats a threshold (default 38), confirmed by a final adversarial scorer. Changes the UI. Trigger on '/ui-critique-loop', 'keep improving this page until it scores above N', or 'score-gate this UI'."
user-invocable: true
disable-model-invocation: false
argument-hint: "[--score N] <page, route, component, URL or flow>"
---

# UI critique loop

Improve a real interface until fresh, blinded reviewers agree that its Impeccable design score is above a threshold. Fix the experience, keep the product's intent, and call it done only when the score is verified.

## Arguments

`/ui-critique-loop [--score N] <target>`

- `--score N` (or `--score=N`) sets the threshold. The default is 38. The old single-dash `-score N` is still accepted until 0.7.0.
- Give it at most once. N must be a whole number from 0 to 39. For a missing, repeated, non-integer or out-of-range value, stop with `Invalid --score: use an integer from 0 through 39.`
- The pass mark is strictly above the threshold: `--score 38` needs 39/40 or better, and `--score 39` needs 40/40.
- Remove the flag; the rest is the target.

## Rules

- **The threshold is literal.** Pass only when the verified score is at least threshold + 1 out of 40. Don't round, average, extrapolate, or rescale a partial score.
- **All 10 heuristics must apply.** Impeccable scores Nielsen's 10 usability heuristics at 4 points each, 40 in all. If the honest maximum for this target is below 40 because some heuristics don't apply, say the threshold can't be compared and ask the owner whether to use an equivalent scaled threshold. Never switch to one silently.
- **Scorers are blind.** Never tell a scoring subagent the threshold, earlier scores, earlier findings, detector output or what was fixed. Give it only the target, the product context, the rubric and access to inspect the current state.
- **Every point needs evidence.** Never raise a score because work was done. Each point needs current source or browser evidence.
- **A passing number isn't enough.** Also require zero open P0/P1 issues, no unapproved detector findings and no failing relevant tests.
- **Keep what the owner asked for.** Preserve the owner's constraints, product truth, data behavior, permissions, accessibility, responsive behavior and the established visual identity, unless the owner asked for a redesign.
- **Repo rules win.** Follow the repo's `AGENTS.md` and `CLAUDE.md` and any matching engineering, testing, security or deployment skill. A design score never bypasses their gates.
- **Keep visual checks short.** In each cycle, check desktop and mobile together, fix that batch, confirm once, and move on.

## Setup

1. Run every critique and every fix through the `impeccable` skill: invoke it with the Skill tool and `args: "<command> <target>"`, written here as `/impeccable <command> <target>`. Under the plugin the name is `power-tools-ui:impeccable`. Never do a command from memory or by reading its reference alone: invoking the skill runs its context setup, loads the command's reference and its craft rules, and uses its detector. Subagents that fix UI invoke it the same way, and their brief says so. If neither name resolves, stop with `Blocked before verification: the impeccable skill is not installed`.
2. Resolve the request to one stable source path or URL. Ask only when the target or a product decision can't be inferred safely.
3. Look at the target and one representative source of visual truth (the design system, `DESIGN.md`, or a neighbouring screen) before planning changes.
4. Invoking this skill is permission to use the subagents the critique needs. Don't ask again.
5. Use Impeccable's critique storage helper and ignore list as documented. Save the baseline and every later scored snapshot.

## Cycle 0: the baseline

Run `/impeccable critique <target>` before editing anything. Impeccable's critique combines two independent reviews:

- **Assessment A** is a design review that scores the target against the heuristics rubric.
- **Assessment B** gathers evidence: it runs Impeccable's detector and inspects the page in a browser.

Impeccable's critique reference owns both. This skill adds the blinding:

1. Run A and B as separate, isolated subagents whenever the Agent tool is available.
2. Give A the design rubric and the current target, and nothing that could anchor it.
3. Give B the detector and browser-evidence instructions. Neither sees the other's work.
4. Let A finish before you read B's findings into the combined result.
5. Combine them and save the full critique: the score, the applicable maximum, severity counts, evidence, the trend and run notes.

If subagents are unavailable or fail, follow Impeccable's degraded path and show its banner. A degraded score can guide fixes, but it can't pass this skill's final check.

When no real product choice is open, skip Impeccable's follow-up priority questions with this note:

`Questions skipped: this skill supplies the scope--fix every in-scope, evidence-backed issue needed to exceed the configured score while preserving the brief.`

## Fix one batch

1. Turn every lost heuristic point, P0/P1 issue, relevant detector finding and persona failure into a concrete fix.
2. Order the fixes: task completion and safety first, then accessibility and responsive behavior, then clarity and consistency, then visual craft.
3. Run each fix through the Impeccable command that owns it, for example `/impeccable harden <target>` for missing states, `clarify` for copy, `layout` for spacing and hierarchy, `typeset`, `colorize`, `adapt` for responsive breaks, `optimize` for performance, and `polish` for consistency. Impeccable loads its craft rules (`craft-floor.md`) before it edits. When a command would stop to ask, take its recommended option (or the one that best keeps the brief) and note the pick in the report.
4. Before changing framework code, load the docs for the framework version in use and the repo's matching skills. For React or Next.js, follow the repo's React guidance. For browser-visible behavior, add or update Playwright coverage in proportion to the change.
5. Make the smallest coherent batch that can win back the missing points. Don't add decoration to impress the rubric.
6. Exercise the changed behavior and its edge states. Run the narrowest relevant tests first, then every gate the repo requires.
7. Check desktop and mobile together, fix what you saw in one pass, and confirm at most once in this cycle.

## Re-score with fresh eyes

After each batch, run a fresh `/impeccable critique <target>` with new A and B subagents. Never reuse an assessor from an earlier cycle when a fresh one is available.

- Build their prompts from the current source and product context, not from earlier reports.
- Keep the baseline's set of applicable heuristics. If an assessor changes it, it must give a concrete reason tied to the surface, and the change never counts as progress: a smaller maximum is not a better score.
- Reuse B's full detector output when combining the results, instead of running the detector again.
- Save the snapshot and compare like with like.

If the combined score isn't above the threshold, its evidence becomes the next batch. Don't argue with a fair deduction; fix the experience.

## Final check: adversarial scorer C

The first time a standard critique reports a score above the threshold:

1. Spawn one more fresh, isolated design scorer, **C**. Give C the same target, the product context and the Nielsen rubric from Impeccable's `critique` reference, but no threshold and no history.
2. C inspects the current interface and returns all 10 scores, concrete evidence for every 4, and a severity tag on every P0/P1 issue it finds.
3. Take the lower of the critique's score and C's total. Never average them.
4. Pass only when both totals are at least threshold + 1, both are out of 40, neither reports a P0/P1 issue, B has no open unapproved finding, and the required tests pass.
5. If any of these fails, the failing score, finding, detector evidence or regression becomes the next batch, within the cycle limit.

## Limits

Run at most **three** fix cycles after the baseline in one invocation. The limit caps cost; it never lowers the bar.

Stop before the limit only when:
- the final check passes;
- a product decision, credential, asset or outside dependency blocks honest progress;
- the next fix would go beyond the target you were given or conflict with a repo gate; or
- the target genuinely can't be scored out of 40.

If the third cycle still scores at or below the threshold, don't claim success. Report the threshold, the exact lower verified score, the trend, the remaining deductions with evidence, the tests run and the smallest next step. Ask the owner before starting another three cycles.

## Report

Start with exactly one of these lines:

- `Verified above <threshold>: <score>/40`
- `Not yet above <threshold>: <score>/40 after three bounded cycles`
- `Threshold not comparable: applicable maximum is <n>, not 40`
- `Blocked before verification: <concrete reason>`

Then list the A and B subagent IDs and C's ID, the score trend, the fixes that mattered most, files changed, browser evidence, detector status, tests and repo gates run, snapshot paths, and any remaining risk. Finishing the work isn't deploying it: never imply a live release without the repo's deployment evidence.
