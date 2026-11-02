// Use case: tests/use-cases/ui-critique-loop.md
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { skillFile } from "../../scripts/layout.mjs";

const SKILL = readFileSync(skillFile("ui-critique-loop", "SKILL.md"), "utf8");
const IMPECCABLE = readFileSync(skillFile("impeccable", "SKILL.md"), "utf8");
const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(SKILL)[1];
const field = (key) => new RegExp(`^${key}: "?(.*?)"?$`, "m").exec(front)?.[1];

test("the frontmatter names the skill and its trigger phrases", () => {
  assert.equal(field("name"), "ui-critique-loop");
  const d = field("description");
  for (const phrase of ["/ui-critique-loop", "keep improving this page until it scores above N", "score-gate this UI", "default 38", "Changes the UI"]) assert.ok(d.includes(phrase), phrase);
  assert.match(field("argument-hint"), /\[--score N\]/);
});

test("the default threshold is 38 and must be beaten, not matched", () => {
  assert.match(SKILL, /The default is 38/);
  assert.match(SKILL, /`--score 38` needs 39\/40 or better/);
  assert.match(SKILL, /`Invalid --score: use an integer from 0 through 39\.`/);
});

test("every step runs through the impeccable skill, or the run is blocked", () => {
  assert.ok(SKILL.includes("Skill tool"));
  assert.ok(SKILL.includes("power-tools-ui:impeccable"));
  assert.ok(SKILL.includes("Blocked before verification: the impeccable skill is not installed"));
  assert.match(SKILL, /Run `\/impeccable critique <target>` before editing anything/);
});

test("scoring is blind, fresh each cycle, and confirmed by an adversarial scorer", () => {
  assert.match(SKILL, /Never tell a scoring subagent the threshold, earlier scores/);
  assert.match(SKILL, /Never reuse an assessor from an earlier cycle/);
  assert.match(SKILL, /Take the lower of the critique's score and C's total\. Never average them\./);
  assert.match(SKILL, /zero open P0\/P1 issues/);
});

test("the loop is bounded and ends in one of four fixed report lines", () => {
  assert.match(SKILL, /at most \*\*three\*\* fix cycles/);
  for (const line of ["Verified above <threshold>: <score>/40", "Not yet above <threshold>: <score>/40 after three bounded cycles", "Threshold not comparable: applicable maximum is <n>, not 40", "Blocked before verification: <concrete reason>"]) {
    assert.ok(SKILL.includes(`\`${line}\``), line);
  }
});

test("the fix commands it names are real Impeccable commands", () => {
  for (const cmd of ["critique", "harden", "clarify", "layout", "typeset", "colorize", "adapt", "optimize", "polish"]) {
    assert.ok(IMPECCABLE.includes(`\`${cmd}`), `impeccable lacks ${cmd}`);
  }
});
