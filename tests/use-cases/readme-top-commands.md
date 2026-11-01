# Use case: copy a command from the README and it works

Sam has just installed the plugin and opens the README's "Top commands" section. They copy
`/implement-to-pr "add CSV export to the Reports page"`, then `/ui-critique-loop --score 36 ...`
and `/fleet-status send all "..."`.

1. Every command in that section names a skill the collection really ships (`/loop` is Claude
   Code's own and wraps a skill).
2. Every switch or subcommand shown, such as `--review-plan`, `--merge`, `--score`, `send`,
   `line`, `init`, `watch`, `check`, `enable merge-gate`, `--deploy` and `resume`, appears in
   that skill's `argument-hint`, so the README never advertises a flag the skill doesn't know.
3. When a skill is renamed or a flag is dropped, `npm test` fails until the README is updated.
