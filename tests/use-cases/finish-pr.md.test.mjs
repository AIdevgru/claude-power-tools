// Use case: tests/use-cases/finish-pr.md
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { skillFile } from "../../scripts/layout.mjs";

const SKILL = readFileSync(skillFile("finish-pr", "SKILL.md"), "utf8").replace(/\r\n/g, "\n");

test("finish-pr triggers on its command and its phrases", () => {
  assert.match(SKILL, /^name: finish-pr$/m);
  assert.match(SKILL, /^description:.*'\/finish-pr <n>'.*'finish #<n>'.*'get #<n> done'/m);
  assert.match(SKILL, /^argument-hint:.*--no-ui.*--score N/m);
  assert.match(SKILL, /default 38, so 39\/40 or better passes/);
});

test("it never merges into main", () => {
  assert.match(SKILL, /\*\*This skill never merges into `main`\.\*\*/);
  assert.match(SKILL, /This skill never merges into `main` or deploys/);
});

test("it updates from main first and defines done as a Remaining work list", () => {
  assert.match(SKILL, /Bring the branch up to date with main/);
  assert.match(SKILL, /Never take "ours" or "theirs" wholesale/);
  assert.match(SKILL, /checkable "Remaining work" list/);
});

test("it reviews twice at high, and gates UI unless --no-ui", () => {
  assert.match(SKILL, /Run the `code-review` skill at `high`/);
  assert.match(SKILL, /Run `code-review` a second time over the whole diff/);
  assert.match(SKILL, /only when the PR touches UI and `--no-ui` wasn't given/);
});

test("a Stop hook demands a FINISH-COMPLETE or FINISH-BLOCKED line", () => {
  assert.match(SKILL, /^hooks:\n {2}Stop:/m);
  assert.match(SKILL, /line starting `FINISH-COMPLETE:`/);
  assert.match(SKILL, /line starting `FINISH-BLOCKED:`/);
});

test("the shared delivery rules it links to exist", () => {
  assert.match(SKILL, /\]\(reference\/delivery-rules\.md\)/);
  assert.ok(existsSync(skillFile("finish-pr", "reference", "delivery-rules.md")));
});
