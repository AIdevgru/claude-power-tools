---
name: issues-to-plan
description: "Turn a short issue list (a doc, tickets, pasted notes) into a verified, PR-sequenced implementation plan: per-issue fixes with path:line evidence, a review that re-checks every claim, then a delivery order. Plan only. Trigger on '/issues-to-plan' or 'write an implementation plan for these issues'."
user-invocable: true
disable-model-invocation: false
argument-hint: "<path to the issue list, or pasted issues>"
---

# Issue list to implementation plan

There are three passes. Each pass rewrites the same plan document, which sits next to the source list as `<source-name>-plan.md` (kebab-case), or in the repo's plans folder when the source was pasted. This skill only produces a plan. It never implements, commits or pushes unless the user separately asks.

## Pass 1: Write a fix plan for each issue

1. Read the source list in full. Number the issues exactly as the source does.
2. Map the code before writing anything.
   - Launch one `Explore` agent per independent area, in parallel, in one message.
   - Ask each agent for `path:line` conclusions, not file dumps.
   - Ask each agent to search likely misspellings too. Issue lists are typed fast ("Deliquency" for "Delinquency").
3. Check every claim that matters to the root cause yourself. Read the cited lines before relying on an agent's summary.
4. Look for "the feature does not exist". When an issue assumes a capability, such as "the API has X endpoints", confirm that X exists at all.
   - Search the whole tree.
   - Search `git branch -a` for unmerged design branches.
   - If X is missing, say so at the top of the plan. It changes the size of every dependent item.
5. For each issue, write:
   - **Current behaviour,** with `path:line`.
   - **Root cause:** say "verified" only if you read the code.
   - **Plan:** numbered steps naming the files to change.
   - **Tests:** unit, integration and end-to-end, at the narrowest level that proves the fix.
   - **Decisions needed from the owner:** only the ones that truly change the design.
6. Respect existing security invariants. If the bug sits on top of a deliberate guard, design around the guard instead of removing it (for example a delete-on-close rule that a test enforces). Cite the test that locks the guard in.
7. Apply the repo's `AGENTS.md`/`CLAUDE.md` triggers inside the plan, not afterwards: threat models for new sensitive data, required test coverage, API or tool parity rules, framework documentation.

## Pass 2: Review and improve

Treat the pass 1 draft as written by someone else. For every section:

- **Re-verify** each `path:line` and each behavioural claim, such as "X is never read" or "Y already does Z". Correct any claim that turns out to be wrong.
- **Check against real inputs.** If the user supplies a sample file, a screenshot or a log, test the plan's rules against it. A rule that would miss the real sample is a critical finding.
- **Find contradictions** between sections, such as a decision answered by the plan's own defaults, or a test that asserts behaviour the plan removes.
- **Find missing pieces:** permissions and their rollout, migrations, retention, audit logging, data exposed to an LLM, timezone and UTC handling, multi-tenant scoping, i18n, and accessibility announcements.
- **Re-check sequencing.** Ship safety nets first. For example, detect and refuse a bad import before building the full feature.
- Append a **Review changelog** listing what changed and why.

## Pass 3: Implementation plan

Restructure the document into:

1. **Delivery sequence table:** PR, scope, the issue it fixes, dependencies, and size.
2. **Decisions needed from the owner,** each tagged with the PR it blocks. Give each a recommended default, so work that is not blocked can start.
3. **One section per PR:** changes with exact files and functions, tests, and "done when".
4. **Validation gate:** the narrow specs first, then the project gate. List known local failures if the repo documents them, and the rules for synthetic fixtures.
5. **Review changelog.**

## Data provenance (hard rule)

A sample from a customer or user (a CSV, an export, a screenshot) is read for **shape only**.

- In the plan, record headers, formats, how many rows each entity has, and edge cases.
- **Never** record names, account numbers, amounts, addresses or other identifying values from the sample.
- **Never** copy the file into the repo, a fixture or a screenshot. Tests use synthetic rows in the same shape.
- If a tool blocks writing derived details, stop and ask the user. Do not route around the block.

## Finish

Reply with:
- the plan's path;
- the top findings;
- the decisions that block work;
- which PRs can start now.

Keep it short. The document holds the detail.
