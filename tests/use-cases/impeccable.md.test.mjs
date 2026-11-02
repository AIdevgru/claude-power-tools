// Use case: tests/use-cases/impeccable.md
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { skillDir, skillFile } from "../../scripts/layout.mjs";
import { REPO, lock, manifest, verify, versionOf } from "../../scripts/vendor.mjs";

const SKILL = readFileSync(skillFile("impeccable", "SKILL.md"), "utf8");
const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(SKILL)[1];
const field = (key) => new RegExp(`^${key}: "?(.*?)"?$`, "m").exec(front)?.[1];
const rel = (...p) => path.relative(REPO, path.join(skillDir("impeccable"), ...p)).replaceAll("\\", "/");

test("Impeccable is installed under its own name and is invocable", () => {
  assert.equal(field("name"), "impeccable");
  assert.equal(field("user-invocable"), "true");
  for (const word of ["design", "critique", "polish", "harden", "frontend interface"]) assert.ok(field("description").includes(word), word);
  for (const cmd of ["critique", "shape", "layout", "harden", "polish", "overdrive"]) {
    assert.match(SKILL, new RegExp(`^\\| \`${cmd}[^\`]*\` \\|`, "m"), `command table lacks ${cmd}`);
    assert.ok(existsSync(skillFile("impeccable", "reference", `${cmd}.md`)), `reference/${cmd}.md`);
  }
});

test("the pinned tag, the lock, the skill's version and THIRD_PARTY.md agree", () => {
  const ref = manifest().impeccable.ref;
  assert.equal(ref, "skill-v4.8.0");
  assert.equal(field("version"), versionOf(ref));
  const l = lock().impeccable;
  assert.equal(l.ref, ref);
  assert.match(l.commit, /^[0-9a-f]{40}$/);
  assert.ok(rel("SKILL.md") in l.files, "SKILL.md is checksummed in the lock");
  const third = readFileSync(path.join(REPO, "THIRD_PARTY.md"), "utf8");
  const row = third.split(/\r?\n/).find((line) => line.startsWith("| Impeccable"));
  assert.ok(row?.includes(ref) && row.includes(l.commit.slice(0, 12)) && row.includes("Apache-2.0"), "THIRD_PARTY.md row");
});

test("its license, notice and four subagents ship with it", () => {
  assert.match(readFileSync(skillFile("impeccable", "LICENSE"), "utf8"), /Apache License/);
  assert.ok(existsSync(skillFile("impeccable", "NOTICE.md")));
  assert.equal(field("license"), "Apache 2.0");
  const agents = Object.keys(manifest().impeccable.files).filter((f) => f.includes("/agents/"));
  assert.equal(agents.length, 4);
  for (const f of agents) assert.ok(existsSync(path.join(REPO, f)), f);
});

test("the vendored copy has no local edits", () => {
  assert.deepEqual(verify(), []);
});

test("the other UI skills call it by name", () => {
  for (const name of ["ux-mockup", "ui-critique-loop", "ui-finalize"]) {
    const text = readFileSync(skillFile(name, "SKILL.md"), "utf8");
    assert.ok(text.includes("power-tools-ui:impeccable") && /\/impeccable \w+/.test(text), name);
  }
});
