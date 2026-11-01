# Auto mode: threat levels

Read this at the start of every `/fleet-manager` tick whose mode is `auto`, before you classify ready PRs. In `manual` it doesn't apply. The mode itself is described in `SKILL.md` under "Deploy mode".

In `auto`, rate every ready PR before you merge it. Base the rating on what the diff touches (`gh pr diff`, the changed files), not on its title.

| Level | Typical changes | In auto |
|---|---|---|
| **low** | docs, tests only, CI comments, copy | merge |
| **medium** | product features or fixes with tests, inside boundaries that already have a threat model | merge |
| **high** | authentication, authorization, tenant isolation, payments, message sending or consent, webhooks, uploads, public endpoints, secrets, migrations that rewrite or drop data, CI or deploy pipeline, runner or server config | Needs owner |
| **critical** | a new trust boundary without a threat model, anything irreversible in production, or open pre-merge review findings | Needs owner, and say why you won't merge it |

Rate at the highest level any part of the diff reaches. If you're unsure between two levels, take the higher one.

Merge on your own only when every check below passes:
- Full CI is green on the PR's exact head SHA, and the head is up to date with `main`.
- The latest `main` commit is green, and its deploy isn't halted or failing as far as you can see.
- The review has no open pre-merge findings.
- The owning session has said the PR is done, or this session owns it.
- No other merge is in flight. Merge one PR at a time, and wait for the next `main` commit's CI to go green before the next merge.

After merging, put it on the tick's Moved line with its rating and one reason, for example `Merged #144 (medium: import duplicate-check scope, tests green)`. Tell the owning session, then mark the PR's superseded PRs for closing.

If a deploy after an auto merge fails or halts, switch to `manual` yourself, note the switch in the ledger, and put the failure first on Needs owner. Never retry or roll back a deploy yourself.
