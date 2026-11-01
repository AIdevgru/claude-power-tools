// Use case: tests/use-cases/delivery-pipelines.md
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { skillDir } from "../../scripts/layout.mjs";
import { SHARED, stale } from "../../scripts/sync-shared.mjs";

const skill = (name) => readFileSync(path.join(skillDir(name), "SKILL.md"), "utf8");
const rulesOf = (name) => readFileSync(path.join(skillDir(name), "reference", "delivery-rules.md"), "utf8");
const front = (text) => /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)[1];
const description = (text) => /^description: "?(.*?)"?$/m.exec(front(text))[1];
const PIPELINES = ["implement-to-pr", "finish-pr", "ticket-to-pr"];

test("every pipeline links the shared delivery rules, and every copy matches", () => {
  const rules = SHARED.find((s) => s.file === "reference/delivery-rules.md");
  assert.deepEqual([rules.from, ...rules.to].sort(), [...PIPELINES].sort());
  for (const name of PIPELINES) assert.match(skill(name), /\[reference\/delivery-rules\.md\]\(reference\/delivery-rules\.md\)/, name);
  assert.deepEqual(stale(), [], "run npm run sync-shared");
});

test("the shared rules cover isolation, updates from main, tracking, models, CI and cleanup", () => {
  const text = rulesOf("implement-to-pr");
  for (const phrase of ["-b <type>/<short-name> origin/main", "<head-branch>", "merging `origin/main`", "**Track it**", "Closes #<n>", "`haiku`", "`sonnet`", "more than 0 checks and 0 failures", "No GitHub remote", "cmd /c rmdir", "Which pipeline", "One repo per session", "Keep your status line current", "approve merge #N"]) {
    assert.ok(text.includes(phrase), `delivery-rules.md lost: ${phrase}`);
  }
});

test("goal-gated pipelines carry a Stop gate that matches their final line", () => {
  for (const [name, word] of [["implement-to-pr", "IMPLEMENT"], ["finish-pr", "FINISH"]]) {
    const text = skill(name);
    const fm = front(text);
    assert.match(fm, /Stop:[\s\S]*type: prompt[\s\S]*once: true/, `${name}: no Stop gate`);
    assert.ok(fm.includes(`${word}-COMPLETE:`) && fm.includes(`${word}-BLOCKED:`), `${name}: gate doesn't name ${word}-COMPLETE/BLOCKED`);
    const body = text.slice(text.indexOf("\n---\n", 4) + 5);
    assert.ok(body.includes(`\`${word}-COMPLETE: `) && body.includes(`\`${word}-BLOCKED: `), `${name}: final line format missing from the body`);
  }
});

test("implement-to-pr can review the plan first, skip the UI gate, and reads the repo's plans-dir", () => {
  const text = skill("implement-to-pr");
  const hint = /^argument-hint: (.*)$/m.exec(front(text))[1];
  for (const flag of ["--review-plan", "--merge", "--no-ui", "--score N"]) assert.ok(hint.includes(flag), `argument-hint lacks ${flag}`);
  assert.match(text, /Review the plan\*\* \(optional: only with `--review-plan`\)/);
  assert.match(text, /Changes to the plan/);
  assert.match(text, /<plans-dir>\/<yyyy-mm-dd>-<short-name>\.md/);
  for (const key of ["tracker:", "push:", "pr-title:", "merge-method:", "plans-dir:"]) assert.ok(text.includes(`\`${key}\``), `implement-to-pr doesn't read ${key}`);
  assert.match(text, /ticket key/);
});

test("ship-plan is a deprecated shim that forwards to implement-to-pr --review-plan --merge", () => {
  const text = skill("ship-plan");
  const fm = front(text);
  assert.match(fm, /^name: ship-plan$/m);
  assert.match(fm, /^disable-model-invocation: true$/m);
  assert.match(fm, /^user-invocable: true$/m);
  assert.ok(!/hooks:/.test(fm), "the shim must not carry its own Stop hook");
  assert.ok(!existsSync(path.join(skillDir("ship-plan"), "reference")), "the shim keeps no reference/ copy");
  assert.match(description(text), /^Deprecated/);
  assert.ok(description(text).length <= 300);
  assert.ok(text.includes("power-tools:implement-to-pr") && text.includes("Skill tool"), "the shim must invoke implement-to-pr through the Skill tool");
  assert.ok(text.includes('args: "--review-plan --merge <original args>"'));
  assert.match(text, /`--no-merge` means drop `--merge`/);
  assert.match(text, /`--no-ui` passes through/);
  assert.match(text, /removed in 0\.7\.0/);
});

test("no pipeline merges without its documented opt-in", () => {
  assert.match(skill("implement-to-pr"), /disable-model-invocation: false/);
  assert.match(skill("implement-to-pr"), /Merging happens only with `--merge`/);
  assert.match(skill("finish-pr"), /This skill never merges into `main`/);
  assert.match(skill("ticket-to-pr"), /Never merge without the explicit "merge" choice/);
  const table = rulesOf("implement-to-pr").split("## Rules")[0];
  for (const row of [/\| `implement-to-pr` \|.*\| only with `--merge` \|/, /\| `finish-pr` \|.*\| never \|/, /\| `ticket-to-pr` \|.*\| asks the owner \|/]) assert.match(table, row);
  assert.ok(!/\| `ship-plan` \|/.test(table), "ship-plan is no longer a row of its own");
});

test("one UI gate lives in the delivery rules, and every pipeline points to it", () => {
  for (const name of PIPELINES) {
    const rules = rulesOf(name);
    const gate = rules.slice(rules.indexOf("## UI gate"));
    assert.ok(rules.includes("## UI gate"), `${name}: its delivery-rules.md has no UI gate`);
    for (const phrase of ["`--no-ui`", "--score <N> <target>", "defaults to 38", "UX persona", "Design persona", "/impeccable <command> <target>", "power-tools-ui:impeccable", "re-run `ui-critique-loop`"]) {
      assert.ok(gate.includes(phrase), `${name}: UI gate lost ${phrase}`);
    }
    assert.ok(!/\/impeccable overdrive/.test(gate), "overdrive isn't part of the automatic UI gate");
    assert.match(skill(name), /UI gate in \[reference\/delivery-rules\.md\]\(reference\/delivery-rules\.md\)/, `${name} doesn't point to the shared UI gate`);
  }
  assert.ok(!skill("finish-pr").includes("senior UX researcher"), "finish-pr still carries its own persona text");
});

test("pipeline descriptions stay at 300 characters or less", () => {
  for (const name of [...PIPELINES, "ship-plan"]) assert.ok(description(skill(name)).length <= 300, `${name}: ${description(skill(name)).length} chars`);
});
