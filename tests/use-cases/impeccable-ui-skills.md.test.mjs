// The UI skills and the shared UI gate run Impeccable through real /impeccable calls, and only name commands the
// bundled Impeccable has. See impeccable-ui-skills.md.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { skillDir, skillNames } from "../../scripts/layout.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VENDORED = new Set(["impeccable", "graphify"]);
const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");
// Repo-relative path of a skill's folder, so failures name the file.
const rel = (name) => path.relative(ROOT, skillDir(name)).replaceAll("\\", "/");
const skill = (name) => read(rel(name), "SKILL.md");
const RULES = `${rel("implement-to-pr")}/reference/delivery-rules.md`;
// The files that do design work: three UI skills and the delivery pipelines' shared UI gate.
const UI_CALLERS = [...["ux-mockup", "ui-critique-loop", "ui-finalize"].map((n) => `${rel(n)}/SKILL.md`), RULES];
const front = (text) => /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)[1];
const field = (text, key) => new RegExp(`^${key}: "?(.*?)"?$`, "m").exec(front(text))?.[1];

// Commands from Impeccable's own Commands table, plus the extra verbs its SKILL.md documents.
function impeccableCommands() {
  const text = skill("impeccable");
  const table = [...text.matchAll(/^\| `([a-z]+)[^`]*` \|/gm)].map((m) => m[1]);
  assert.ok(table.length >= 20, `only ${table.length} commands parsed from impeccable/SKILL.md`);
  const extra = ["hooks", "doctor", "pin", "unpin", "teach"].filter((c) => text.includes(c));
  return new Set([...table, ...extra]);
}

test("every UI caller runs Impeccable through the Skill tool, under both names", () => {
  for (const name of UI_CALLERS) {
    const text = read(name);
    assert.ok(text.includes("Skill tool"), `${name}: doesn't say to invoke Impeccable with the Skill tool`);
    assert.ok(text.includes("power-tools-ui:impeccable"), `${name}: missing the plugin-namespaced name`);
    assert.ok(/\/impeccable ([a-z]+|<command>) <target>/.test(text), `${name}: no /impeccable <command> <target> call`);
  }
});

test("no UI skill imitates Impeccable by loading references by hand", () => {
  const imitations = [
    /Load and follow (the third-party `impeccable`|Impeccable \w+)/,
    /read `reference\/<command>\.md`/,
    /Invoke `impeccable` with/,
    /Load the Impeccable command reference/,
  ];
  for (const name of UI_CALLERS) {
    for (const re of imitations) assert.ok(!re.test(read(name)), `${name} still says ${re}`);
  }
});

test("every /impeccable command our skills and docs name exists in the bundled Impeccable", () => {
  const known = impeccableCommands();
  const ours = skillNames().filter((n) => !VENDORED.has(n)).map((n) => [rel(n), skill(n)]);
  for (const [where, text] of [...ours, [RULES, read(RULES)], ["README.md", read("README.md")]]) {
    for (const [, cmd] of text.matchAll(/\/impeccable ([a-z]+)/g)) {
      assert.ok(known.has(cmd), `${where} calls /impeccable ${cmd}, which Impeccable doesn't have`);
    }
  }
});

test("the automatic UI gate never runs overdrive", () => {
  const rules = read(RULES);
  assert.ok(!rules.slice(rules.indexOf("## UI gate")).includes("/impeccable overdrive"), "the UI gate runs overdrive");
});

test("ui-finalize gates on the score, lets the owner pick overdrive, then hardens, polishes and re-critiques", () => {
  const text = skill("ui-finalize");
  const at = (s) => text.indexOf(s);
  const order = ["/ui-critique-loop --score <threshold> <target>", "/impeccable overdrive <target>", "/impeccable harden <target>", "/impeccable polish <target>", "## Phase 5"];
  for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]) > 0 && at(order[i - 1]) < at(order[i]), `${order[i - 1]} must come before ${order[i]}`);
  assert.match(text, /Stop and ask the owner to choose/);
  assert.match(text, /choose exactly one recovery command/);
  assert.match(text, /never start another recovery on your own/);
});

test("ui-critique-loop keeps its strict, blinded, bounded scoring rules", () => {
  const text = skill("ui-critique-loop");
  for (const phrase of [
    "at least threshold + 1 out of 40", "`--score 38` needs 39/40", "All 10 heuristics must apply", "Never switch to one silently",
    "Scorers are blind", "Never reuse an assessor", "adversarial scorer C", "no threshold and no history",
    "Take the lower of the critique's score and C's total. Never average them.", "zero open P0/P1 issues",
    "no unapproved detector findings", "at most **three** fix cycles", "Assessment A", "Assessment B",
    "`Verified above <threshold>: <score>/40`", "`Not yet above <threshold>: <score>/40 after three bounded cycles`",
    "`Threshold not comparable: applicable maximum is <n>, not 40`", "`Blocked before verification: <concrete reason>`",
  ]) assert.ok(text.includes(phrase), `ui-critique-loop lost: ${phrase}`);
});

test("the UI skills are typed and invoked like the rest, with short descriptions", () => {
  for (const name of ["ui-critique-loop", "ui-finalize", "ux-mockup"]) {
    const text = skill(name);
    assert.equal(field(text, "user-invocable"), "true", name);
    assert.equal(field(text, "disable-model-invocation"), "false", name);
    assert.ok(field(text, "argument-hint")?.includes("--score N"), `${name}: argument-hint lacks --score N`);
    assert.ok(field(text, "description").length <= 300, `${name}: description is ${field(text, "description").length} chars`);
  }
  assert.ok(!field(skill("ui-critique-loop"), "description").includes("/impeccable critique"), "ui-critique-loop claims Impeccable's own command");
});

test("flags use double dashes; a single-dash flag appears only as the deprecated alias", () => {
  const files = skillNames().filter((n) => !VENDORED.has(n)).map((n) => `${rel(n)}/SKILL.md`);
  for (const where of [...files, RULES, "README.md"]) {
    for (const line of read(where).split(/\r?\n/)) {
      if (/(^|[\s`(\[])-(score|rating|no-overdrive)\b/.test(line)) assert.ok(line.includes("0.7.0"), `${where} documents a single-dash flag: ${line.trim()}`);
    }
  }
});

test("the README skills table has no column of old names", () => {
  const readme = read("README.md");
  assert.ok(readme.includes("| Skill | What it does | Needs |"));
  assert.ok(!readme.includes("| Was |"), "README still has a Was column");
});
