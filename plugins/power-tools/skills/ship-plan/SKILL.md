---
name: ship-plan
description: "Deprecated: ship-plan is now /implement-to-pr --review-plan --merge, and this alias forwards to it. It will be removed in 0.7.0. Trigger on '/ship-plan'."
user-invocable: true
disable-model-invocation: true
argument-hint: "<plan text, file path, ticket key, or PR/issue link> [--no-merge] [--no-ui]"
---

# Ship a plan (deprecated)

`ship-plan` is now `/implement-to-pr --review-plan --merge`; it will be removed in 0.7.0. It reviews and improves the plan, builds it, opens and reviews the PR, runs the UI gate, and merges once CI is green. It no longer runs an overdrive pass; use `/ui-finalize` for that.

Tell the owner that in one line, then invoke the `implement-to-pr` skill with the Skill tool (`power-tools:implement-to-pr` under the plugin) and `args: "--review-plan --merge <original args>"`, where `<original args>` is `$ARGUMENTS` with these changes:

- `--no-merge` means drop `--merge` (and `--no-merge` itself), so the run stops at a reviewed, green PR.
- `--no-ui` passes through unchanged, as does everything else.

Then follow `implement-to-pr` to its end, including its `IMPLEMENT-COMPLETE:` or `IMPLEMENT-BLOCKED:` line.
