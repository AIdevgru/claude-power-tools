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

test("core flows come first: named in stage 1, run end to end, walked first by the personas", () => {
  assert.match(SKILL, /\*\*Focus on the core flows\.\*\* Stage 1 names them/);
  assert.match(SKILL, /Name the \*\*core flows\*\*/);
  assert.match(SKILL, /every core flow runs from start to done/);
  assert.match(SKILL, /walk each core flow from start to done before anything else/);
  assert.match(SKILL, /\*\*Current state:\*\* the core flows/);
});

test("fixers are told to remove or fold before they add", () => {
  assert.match(SKILL, /\*\*Fixers remove or fold before they add\.\*\*/);
  assert.match(SKILL, /prefer removing an element, or folding it into one that already exists, over adding a feature/);
  // Both fix loops repeat the rule, and an addition has to be justified in the log.
  assert.match(SKILL, /Subagents apply the remediations, core flows first, removing or folding before adding/);
  assert.match(SKILL, /with one writer per file, removing or folding before adding/);
  assert.match(SKILL, /each addition a fixer made and why/);
});

test("a score that sits steady between rounds is diagnosed and the approach changes", () => {
  assert.match(SKILL, /\*\*If a score sits steady between rounds, find out why and adjust\.\*\*/);
  assert.match(SKILL, /don't run the same kind of fix again/);
  assert.match(SKILL, /If the score sits steady between rounds, find out why and adjust before the next round/);
  assert.match(SKILL, /If a rating sits steady between rounds, find out why and adjust/);
  assert.match(SKILL, /each score that sat steady, with its cause and the change made/);
});

test("the shared kit is updated if needed, but never inside product code", () => {
  assert.match(SKILL, /\*\*Update the shared kit if needed\.\*\*/);
  assert.match(SKILL, /A kit inside product code is product code: don't edit it/);
  assert.match(SKILL, /The only files it may link are the project's shared kit/);
  assert.match(SKILL, /\*\*Shared kit:\*\* the kit changes made/);
});

test("the mockup and the plan go to the stated paths, with synthetic data", () => {
  assert.ok(SKILL.includes("docs/design/<feature-slug>/mockup/index.html"));
  assert.ok(SKILL.includes("docs/plans/<YYYY-MM-DD>-<feature-slug>-ux.md"));
  assert.match(SKILL, /\*\*Synthetic data only\.\*\*/);
});
