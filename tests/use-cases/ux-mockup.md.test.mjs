// Use case: tests/use-cases/ux-mockup.md
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { skillFile } from "../../scripts/layout.mjs";

const SKILL = readFileSync(skillFile("ux-mockup", "SKILL.md"), "utf8");
const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(SKILL)[1];
const field = (key) => new RegExp(`^${key}: "?(.*?)"?$`, "m").exec(front)?.[1];

test("the frontmatter names the skill and its trigger phrases", () => {
  assert.equal(field("name"), "ux-mockup");
  const d = field("description");
  for (const phrase of ["/ux-mockup", "mock up <feature>", "UX plan with a mockup", "never edits product code"]) assert.ok(d.includes(phrase), phrase);
  assert.match(field("argument-hint"), /<feature> \[--score N\] \[--rating N\]/);
});

test("it never changes product code and needs Impeccable and ui-critique-loop", () => {
  assert.match(SKILL, /\*\*This skill never changes product code, opens a PR, merges or deploys\.\*\*/);
  assert.match(SKILL, /Requires\*\* the third-party `impeccable` skill/);
  assert.ok(existsSync(skillFile("impeccable", "SKILL.md")));
  assert.ok(existsSync(skillFile("ui-critique-loop", "SKILL.md")));
  assert.match(SKILL, /If `impeccable` isn't installed, say so in one line and stop/);
});

test("defaults are a score above 38, a rating of 9 and five rounds", () => {
  assert.match(SKILL, /the critique threshold, default \*\*38\*\*/);
  assert.match(SKILL, /minimum persona rating, default \*\*9\*\*/);
  assert.match(SKILL, /at most \*\*5\*\* persona rounds and \*\*5\*\* critique rounds/);
});

test("recommended options are auto-picked and logged", () => {
  assert.match(SKILL, /\*\*Pick the recommended option yourself/);
  assert.match(SKILL, /Decisions log/);
  assert.match(SKILL, /Continue without calling `AskUserQuestion`/);
});

test("the stages run in order through real Impeccable commands", () => {
  const at = (s) => SKILL.indexOf(s);
  const order = ["/impeccable shape <feature>", "Build mockup v1", "/impeccable layout <mockup>", "/impeccable harden <mockup>", "/impeccable overdrive <mockup>", "Critique until the score", "UX and Designer personas iterate", "Publish and write the plan"];
  for (let i = 0; i < order.length; i++) assert.ok(at(order[i]) > 0, `missing ${order[i]}`);
  for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]) < at(order[i]), `${order[i - 1]} before ${order[i]}`);
  assert.match(SKILL, /never score it yourself/);
  assert.ok(SKILL.includes("power-tools-ui:impeccable"));
});

test("the mockup and the plan go to the stated paths, with synthetic data", () => {
  assert.ok(SKILL.includes("docs/design/<feature-slug>/mockup/index.html"));
  assert.ok(SKILL.includes("docs/plans/<YYYY-MM-DD>-<feature-slug>-ux.md"));
  assert.match(SKILL, /\*\*Synthetic data only\.\*\*/);
});
