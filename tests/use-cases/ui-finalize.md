# Use case: finishing a page for release

Lee's team ships the settings page on Friday. Lee wants one pass that takes it to release quality.

1. Lee types `/ui-finalize settings`. The skill works in a fixed order: the `ui-critique-loop`
   score gate, overdrive, harden, polish, then a final critique.
2. Phase 1 runs `/ui-critique-loop --score 38 settings`. If that doesn't verify a score above
   38, the skill stops there. Overdrive is never used to cover weak basics.
3. Phase 2 runs `/impeccable overdrive settings`. The skill proposes two or three directions,
   including `Skip overdrive`, and stops to ask Lee which one. It builds only the one Lee picks.
   It never runs overdrive again on its own.
4. Phase 3 hardens the result with `/impeccable harden`. Phase 4 runs `/impeccable polish`
   last, so it sees every state the earlier phases added.
5. Phase 5 is a fresh, blinded `/impeccable critique`, run by new subagents that are not told
   the threshold or what was fixed.
6. If the final critique fails, the skill picks exactly one recovery command and runs it once.
   Then it critiques one last time. It never starts another recovery by itself.
7. Lee's teammate runs `/ui-finalize --no-overdrive settings` to skip phase 2. The report
   starts with one fixed line, such as `Finalized and verified above 38: 39/40`.
