# Use case: the UI skills run Impeccable, not an imitation of it

`ux-mockup`, `ui-critique-loop` and `ui-finalize` do design work, and so does the UI gate
that the delivery pipelines share in `delivery-rules.md`. Each design step is a real
`/impeccable <command> <target>` call, so it gets Impeccable's context setup (PRODUCT.md,
DESIGN.md, the surface brief), its craft rules and its detector. A step done from memory,
or from reading one reference file, skips all three.

1. Riley, a product engineer, runs `/ux-mockup checkout`. The skill invokes
   `/impeccable shape checkout` through the Skill tool, takes the recommended answer at
   each interview question, and logs the pick. A subagent builds the mockup by invoking
   `/impeccable` with the brief, then the skill runs `/impeccable layout`, `harden` and
   `overdrive` on it before `ui-critique-loop` scores it.
2. Riley installed the `power-tools-ui` plugin, so the skill is named
   `power-tools-ui:impeccable`. Every UI skill names both forms, so the call
   resolves either way.
3. Later, Riley runs `/implement-to-pr` on a plan that touches the settings page. Its UI
   gate runs `ui-critique-loop --score 38` on the page, then the UX and Design persona
   review, whose fixes go through `/impeccable <command> <target>`. It never runs
   overdrive on its own.
4. Riley wants an ambitious finish for the release, so they run
   `/ui-finalize --score 37 settings`. It passes the score gate first, then proposes
   overdrive directions and waits for Riley to pick one, then hardens, polishes and runs
   a final blinded critique, in that order. `ux-mockup`, by contrast, picks the
   recommended overdrive direction itself and logs it.
5. Every flag uses double dashes: `--score N`, `--rating N`, `--no-overdrive`. Riley's
   old habit of typing `-score 37` still works until 0.7.0, and each skill says so; no
   skill documents a single-dash flag anywhere else.
6. A maintainer updates the bundled Impeccable to a release that renames a command.
   `npm test` fails and names the skill that still calls the old command, so the drift
   is fixed before release.
7. The README's skills table lists each skill, what it does and what it needs, without
   the old skill names.
