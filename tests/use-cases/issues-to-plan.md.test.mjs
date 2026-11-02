// Use case: tests/use-cases/issues-to-plan.md
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { skillFile } from "../../scripts/layout.mjs";

const SKILL = readFileSync(skillFile("issues-to-plan", "SKILL.md"), "utf8");

test("issues-to-plan triggers on its command and its phrase", () => {
  assert.match(SKILL, /^name: issues-to-plan$/m);
  assert.match(SKILL, /^description:.*'\/issues-to-plan'.*'write an implementation plan for these issues'/m);
  assert.match(SKILL, /^argument-hint:.*path to the issue list, or pasted issues/m);
});

test("it only plans: no implementing, committing or pushing", () => {
  assert.match(SKILL, /This skill only produces a plan\. It never implements, commits or pushes/);
  assert.match(SKILL, /<source-name>-plan\.md/);
});

test("pass 1 maps the code with parallel Explore agents and path:line evidence", () => {
  assert.match(SKILL, /one `Explore` agent per independent area, in parallel/);
  assert.match(SKILL, /`path:line` conclusions, not file dumps/);
  assert.match(SKILL, /likely misspellings/);
  assert.match(SKILL, /say "verified" only if you read the code/);
  assert.match(SKILL, /"the feature does not exist"/);
});

test("pass 2 re-verifies every claim and appends a Review changelog", () => {
  assert.match(SKILL, /## Pass 2: Review and improve/);
  assert.match(SKILL, /\*\*Re-verify\*\* each `path:line`/);
  assert.match(SKILL, /Append a \*\*Review changelog\*\*/);
});

test("pass 3 ends in a delivery sequence table with owner decisions and a validation gate", () => {
  assert.match(SKILL, /\*\*Delivery sequence table:\*\*/);
  assert.match(SKILL, /\*\*Decisions needed from the owner,\*\* each tagged with the PR it blocks/);
  assert.match(SKILL, /\*\*Validation gate:\*\*/);
});

test("customer samples are read for shape only", () => {
  assert.match(SKILL, /Data provenance \(hard rule\)/);
  assert.match(SKILL, /read for \*\*shape only\*\*/);
  assert.match(SKILL, /\*\*Never\*\* copy the file into the repo/);
});
