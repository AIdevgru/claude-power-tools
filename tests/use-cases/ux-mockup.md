# Use case: a UX plan with a mockup, without touching the product

Lee wants to rework the checkout flow, but doesn't want any product code to change yet.

1. Lee types `/ux-mockup checkout`. If the feature name is missing, the skill asks once.
   The thresholds default to a critique score above 38 and a persona rating of at least 9.
2. The skill needs `impeccable` and `ui-critique-loop`. If `impeccable` isn't installed,
   it says so in one line and stops.
3. Impeccable commands would normally stop and ask. Here the skill picks the recommended option
   itself and writes the question, the options and its pick in the plan's Decisions log. It only
   stops for something with no sensible default, such as money or a legal trade-off.
4. The stages run in order: ground the current feature, `shape`, build the mockup, `layout`,
   `harden`, `overdrive`, the critique loop, then a UX persona and a Designer persona who review
   in rounds.
5. The mockup is one self-contained HTML file at `docs/design/<feature-slug>/mockup/index.html`.
   It uses invented data only, and has working states and a dark mode.
6. Scoring is left to the blinded `ui-critique-loop` subagents. Each loop is capped at five rounds.
   If the cap is hit, the skill reports the best version and what is left.
7. The plan goes to `docs/plans/<YYYY-MM-DD>-<feature-slug>-ux.md`. The skill never edits
   product code, opens a PR, merges or deploys. The final report is short.
