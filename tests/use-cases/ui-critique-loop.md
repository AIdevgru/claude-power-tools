# Use case: improving a page until a blinded score says it is good

Lee's settings page feels clumsy. Lee wants proof that it got better, not a feeling.

1. Lee types `/ui-critique-loop settings page`. No `--score` is given, so the threshold is 38.
   The pass mark is strictly above it, so the page needs 39 out of 40.
2. The skill runs every step through the `impeccable` skill, never from memory. Without it,
   the skill stops with `Blocked before verification`.
3. Cycle 0 is `/impeccable critique` before any edit. Two isolated subagents score it. A rates
   the design. B runs the detector and inspects the page. Neither is told the threshold or
   any earlier result.
4. The skill fixes one batch at a time. Each fix goes through the Impeccable command that owns it,
   such as `harden`, `clarify` or `layout`. Then it re-scores with fresh subagents.
5. At most three fix cycles run. When the score first beats the threshold, a third, adversarial
   scorer C checks it. The skill keeps the lower of the two totals and never averages them. It
   also needs zero open P0 and P1 issues.
6. Lee tries `/ui-critique-loop --score 45`. The skill stops with
   `Invalid --score: use an integer from 0 through 39.`
7. The report starts with one fixed line, such as `Verified above 38: 39/40`, or says it
   was not reached after three cycles.
