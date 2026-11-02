// Use case: tests/use-cases/implement-to-pr.md
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { skillFile } from "../../scripts/layout.mjs";

const SKILL = readFileSync(skillFile("implement-to-pr", "SKILL.md"), "utf8").replace(/\r\n/g, "\n");

test("implement-to-pr takes the documented flags and triggers", () => {
  assert.match(SKILL, /^name: implement-to-pr$/m);
  assert.match(SKILL, /^description:.*'\/implement-to-pr'.*'implement this and open a PR'.*'take this plan to a reviewed PR'/m);
  assert.match(SKILL, /^argument-hint:.*--review-plan.*--merge.*--no-ui.*--score N/m);
});

test("it reads the repo's Power tools settings", () => {
  assert.match(SKILL, /`## Power tools` section/);
  for (const key of ["tracker:", "push:", "pr-title:", "merge-method:", "plans-dir:"]) assert.ok(SKILL.includes(`\`${key}\``), key);
});

test("--review-plan writes a dated plan file before building", () => {
  assert.match(SKILL, /`--review-plan`: review and improve the plan/);
  assert.match(SKILL, /<plans-dir>\/<yyyy-mm-dd>-<short-name>\.md/);
  assert.match(SKILL, /Changes to the plan/);
});

test("without --merge it stops at a ready PR and does not merge", () => {
  assert.match(SKILL, /Without it, stop at a reviewed, green, ready-for-review PR and \*\*do not merge\*\*/);
  assert.match(SKILL, /only with `--merge`/);
  assert.match(SKILL, /Zero checks plus "mergeable" is not green/);
  assert.match(SKILL, /this skill never deploys/);
});

test("it reviews at high until clean, waits for CI on the head commit, then moves the ticket", () => {
  assert.match(SKILL, /Run `code-review` at `high` on the PR/);
  assert.match(SKILL, /gh pr checks <n> --watch/);
  assert.match(SKILL, /Once CI is green, move the ticket to In Review/);
});

test("a Stop hook demands an IMPLEMENT-COMPLETE or IMPLEMENT-BLOCKED line", () => {
  assert.match(SKILL, /^hooks:\n {2}Stop:/m);
  assert.match(SKILL, /line starting `IMPLEMENT-COMPLETE:`/);
  assert.match(SKILL, /line starting `IMPLEMENT-BLOCKED:`/);
});

test("the shared delivery rules it links to exist", () => {
  assert.match(SKILL, /\]\(reference\/delivery-rules\.md\)/);
  assert.ok(existsSync(skillFile("implement-to-pr", "reference", "delivery-rules.md")));
});
