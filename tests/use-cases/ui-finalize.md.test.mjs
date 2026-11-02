// Use case: tests/use-cases/ui-finalize.md
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { skillFile } from "../../scripts/layout.mjs";

const SKILL = readFileSync(skillFile("ui-finalize", "SKILL.md"), "utf8");
const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(SKILL)[1];
const field = (key) => new RegExp(`^${key}: "?(.*?)"?$`, "m").exec(front)?.[1];
const phase = (n) => SKILL.slice(SKILL.indexOf(`## Phase ${n}`), SKILL.indexOf(`## Phase ${n + 1}`));

test("the frontmatter names the skill and its trigger phrases", () => {
  assert.equal(field("name"), "ui-finalize");
  const d = field("description");
  for (const phrase of ["/ui-finalize", "finalize this page for release", "harden and polish this UI"]) assert.ok(d.includes(phrase), phrase);
  assert.match(field("argument-hint"), /\[--score N\] \[--no-overdrive\]/);
});

test("the phases run in the stated order", () => {
  assert.ok(SKILL.includes("`ui-critique-loop -> overdrive (the owner picks) -> harden -> polish -> final critique`"));
  for (const n of [1, 2, 3, 4]) assert.ok(SKILL.includes(`## Phase ${n}:`), `phase ${n}`);
  assert.match(phase(1), /\/ui-critique-loop --score <threshold> <target>/);
  assert.match(phase(2), /\/impeccable overdrive <target>/);
  assert.match(phase(3), /\/impeccable harden <target>/);
  assert.match(phase(4), /\/impeccable polish <target>/);
  assert.ok(SKILL.includes("## Phase 5: the final independent critique"));
});

test("phase 1 must pass first, and overdrive is the owner's choice, once", () => {
  assert.match(phase(1), /Don't use overdrive to cover weak fundamentals/);
  assert.match(phase(2), /Include `Skip overdrive`/);
  assert.match(phase(2), /Stop and ask the owner to choose/);
  assert.match(phase(2), /Never run overdrive again on your own/);
  assert.match(SKILL, /`--no-overdrive`, at most once, skips phase 2/);
});

test("the final critique is blinded, and recovery is one command, once", () => {
  assert.match(SKILL, /Don't tell them the threshold, the baseline score/);
  assert.match(SKILL, /choose exactly one recovery command/);
  assert.match(SKILL, /never start another recovery on your own/);
});

test("it uses the default 38 and the fixed report lines", () => {
  assert.match(SKILL, /The default is 38/);
  assert.match(SKILL, /`Invalid --score: use an integer from 0 through 39\.`/);
  for (const line of ["Finalized and verified above <threshold>: <score>/40", "Not finalized: <score>/40 after one targeted recovery", "Threshold not comparable: applicable maximum is <n>, not 40", "Blocked before final verification: <reason>"]) {
    assert.ok(SKILL.includes(`\`${line}\``), line);
  }
});
