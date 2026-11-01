// Repository-wide checks: skill frontmatter, matching use-case stories and tests, renamed-skill
// references, and private strings that must never ship in a generic collection.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PLUGINS, pluginDir, pluginHooks, pluginOf, skillDir, skillDirs, skillFile, skillMap, skillModule, skillNames as layoutSkillNames } from "../scripts/layout.mjs";

const { PROBES } = await skillModule("update", "scripts/doctor.mjs");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const skillNames = layoutSkillNames();
const readJson = (...p) => JSON.parse(readFileSync(path.join(...p), "utf8"));

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

// Every text file in the repo, tracked or not, minus dependencies and caches.
function textFiles(dir = ROOT, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "__pycache__"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) textFiles(p, out);
    else if (/\.(md|mjs|js|json|py|txt|yaml|yml)$|^\.gitignore$|^gitignore$/.test(e.name)) out.push(p);
  }
  return out;
}

// Vendored skills keep their upstream descriptions, so they only get the platform's 1024 limit.
const VENDOR = JSON.parse(readFileSync(path.join(ROOT, "vendor.json"), "utf8"));
const SKILL_AT = Object.entries(skillMap()).map(([name, s]) => [name, `${s.dir}/`]);
const vendoredSkills = new Set(
  Object.entries(VENDOR).filter(([k]) => !k.startsWith("$"))
    .flatMap(([, v]) => Object.keys(v.files ?? {}))
    .map((p) => SKILL_AT.find(([, dir]) => `${p}/`.startsWith(dir))?.[0]).filter(Boolean),
);
// First-party descriptions load into every session's skill listing, so they stay short.
const FIRST_PARTY_DESCRIPTION_MAX = 300;

test("every skill has frontmatter whose name matches its folder", () => {
  assert.ok(skillNames.length >= 15, skillNames.join(", "));
  for (const name of skillNames) {
    const file = skillFile(name, "SKILL.md");
    assert.ok(existsSync(file), `${name}: SKILL.md missing`);
    const fm = frontmatter(readFileSync(file, "utf8"));
    assert.ok(fm, `${name}: no frontmatter`);
    assert.equal(fm.name, name, `${name}: frontmatter name is ${fm.name}`);
    assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${name}: not kebab-case`);
    assert.ok(fm.description && fm.description.length >= 80, `${name}: description too short`);
    assert.ok(fm.description.length <= 1024, `${name}: description is ${fm.description.length} chars (max 1024)`);
  }
});

test("first-party skill descriptions are 300 characters or less; vendored ones keep upstream's", () => {
  assert.ok(vendoredSkills.has("impeccable") && vendoredSkills.has("graphify"), [...vendoredSkills].join(", "));
  const over = [];
  for (const name of skillNames.filter((n) => !vendoredSkills.has(n))) {
    const len = frontmatter(readFileSync(skillFile(name, "SKILL.md"), "utf8")).description.length;
    if (len > FIRST_PARTY_DESCRIPTION_MAX) over.push(`${name} (${len})`);
  }
  assert.deepEqual(over, [], `descriptions over ${FIRST_PARTY_DESCRIPTION_MAX} chars: ${over.join(", ")}`);
});

test("relative links inside skills point at files that exist", () => {
  for (const name of skillNames) {
    const text = readFileSync(skillFile(name, "SKILL.md"), "utf8");
    for (const [, target] of text.matchAll(/\]\(((?:reference|scripts|templates)\/[^)#]+)\)/g)) {
      assert.ok(existsSync(skillFile(name, target)), `${name}: broken link ${target}`);
    }
    // First-party reference files link to each other relative to their own folder.
    const refDir = skillFile(name, "reference");
    if (vendoredSkills.has(name) || !existsSync(refDir)) continue;
    for (const ref of readdirSync(refDir).filter((f) => f.endsWith(".md"))) {
      const refText = readFileSync(path.join(refDir, ref), "utf8");
      for (const [, target] of refText.matchAll(/\]\(([^)#:\s]+\.md)\)/g)) {
        assert.ok(existsSync(path.join(refDir, target)), `${name}/reference/${ref}: broken link ${target}`);
      }
    }
  }
});

test("every use-case story has a test of the same name, and the reverse", () => {
  const dir = path.join(ROOT, "tests", "use-cases");
  const files = readdirSync(dir);
  const stories = files.filter((f) => f.endsWith(".md")).sort();
  const tests = files.filter((f) => f.endsWith(".md.test.mjs")).map((f) => f.replace(/\.test\.mjs$/, "")).sort();
  assert.deepEqual(tests, stories);
});

test("no skill still refers to an old skill name", () => {
  const old = [
    "/manager", "gh-summary", "gh_summary", "merge-prs", "plan-to-merge", "implement-pr", "monitor-inbox", "read-inbox",
    "jira-act", "jira-triage", "impeccable-critique", "impeccable-finalize", "forclaude-inbox", "gh-merge-open-prs",
    "issue-list-implementation-plan", "/mock ", "skill: \"manager\"",
  ];
  for (const file of skillDirs().flatMap((d) => textFiles(d))) {
    const text = readFileSync(file, "utf8");
    for (const word of old) assert.ok(!text.includes(word), `${path.relative(ROOT, file)} mentions ${word}`);
  }
});

test("CI runs the suite, the vendor check and the shared-file check on Linux and Windows", () => {
  const ci = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  for (const s of ["ubuntu-latest", "windows-latest", "npm test", "npm run vendor:verify", "sync-shared.mjs --check", "pull_request"]) {
    assert.ok(ci.includes(s), `ci.yml lost: ${s}`);
  }
});

test("every hook script answers --self-test, so the doctor can tell a broken hook from an idle one", () => {
  // Hooks from every plugin: an installer install registers them all in one settings.json.
  const pairs = Object.keys(PLUGINS).flatMap((plugin) => Object.entries(pluginHooks(plugin).hooks)
    .flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.map((h) => `${/\/skills\/(.+?\.mjs)/.exec(h.command)?.[1]} ${event}`))));
  const registered = new Set(pairs.filter((p) => !p.startsWith("update/scripts/doctor.mjs")));
  const probed = Object.values(PROBES).flatMap((p) => p.events.map((e) => `${p.script} ${e}`));
  assert.deepEqual([...registered].sort(), probed.sort(), "the doctor's PROBES must list every hook script and the events it's registered for");
  const scripts = new Set(Object.values(PROBES).map((p) => p.script));
  for (const rel of scripts) {
    const [skill, ...rest] = rel.split("/");
    const r = execFileSync(process.execPath, [skillFile(skill, ...rest), "--self-test"], { encoding: "utf8" });
    assert.match(r, /^ok\b/m, rel);
  }
});

test("scripts detect a direct run by real path, so they work through linked installs", () => {
  for (const file of textFiles().filter((f) => f.endsWith(".mjs") && !f.includes(`${path.sep}tests${path.sep}`))) {
    const text = readFileSync(file, "utf8");
    assert.ok(!/resolve\(process\.argv\[1\]\)\)\.href === import\.meta\.url/.test(text), `${path.relative(ROOT, file)} compares argv[1] to import.meta.url without realpath`);
  }
});

test("no private names, paths or IDs ship in the collection", () => {
  // Built from parts so this file doesn't match itself.
  const banned = [
    ["Za", "ch"], ["zw", "ymer"], ["Ed", "Tok"], ["ed", "tok"], ["Mercury", "Reach"], ["mercury", "reach"], ["Tenant", "Reach"],
    ["C:/", "Users"], ["C:\\", "Users"], ["10.147", "."], ["a484af26", "-"], ["712020", ":"], ["shrodikan", ""],
    ["KAN", "-"], ["C:/", "tmp"], ["needs-", "zach"],
  ].map(([a, b]) => a + b);
  const self = fileURLToPath(import.meta.url);
  for (const file of textFiles()) {
    if (file === self) continue;
    const text = readFileSync(file, "utf8");
    for (const word of banned) assert.ok(!text.includes(word), `${path.relative(ROOT, file)} contains "${word}"`);
  }
});

test("every plugin manifest and hooks file is valid, and each hook runs a script inside its own plugin", () => {
  const { version } = readJson(ROOT, "package.json");
  assert.match(version, /^\d+\.\d+\.\d+$/);
  for (const plugin of Object.keys(PLUGINS)) {
    const dir = pluginDir(plugin);
    const manifest = readJson(dir, ".claude-plugin", "plugin.json");
    assert.equal(manifest.name, plugin);
    assert.equal(manifest.version, version, `${plugin}: plugin.json and package.json versions differ`);
    assert.equal(manifest.license, "Apache-2.0", plugin);
    assert.equal(manifest.author?.name, "aidevgru", plugin);
    assert.match(manifest.repository, /^https:\/\/github\.com\//, plugin);
    assert.ok(manifest.description && manifest.description.length <= 200, `${plugin}: description is ${manifest.description?.length} chars (max 200)`);
    assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length, plugin);
    for (const group of Object.values(pluginHooks(plugin).hooks).flat()) {
      for (const h of group.hooks) {
        const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/(skills\/[^"]+)"/.exec(h.command);
        assert.ok(m && !m[1].includes(".."), `${plugin}: ${h.command}`);
        assert.ok(existsSync(path.join(dir, m[1])), `${plugin}: ${h.command} names a script outside the plugin`);
        execFileSync(process.execPath, ["--check", path.join(dir, m[1])]);
      }
    }
  }
  // The pre-0.6 single plugin at the repo root is gone; only the marketplace stays there.
  assert.ok(!existsSync(path.join(ROOT, ".claude-plugin", "plugin.json")), "root plugin.json is back");
  assert.ok(!existsSync(path.join(ROOT, "hooks", "hooks.json")), "root hooks/hooks.json is back");
});

test("every trigger eval names a real skill of its own plugin that Claude is allowed to invoke", () => {
  // claude plugin eval loads one plugin, so each case lives in the plugin that ships its skill.
  const cases = Object.keys(PLUGINS).flatMap((plugin) => {
    const dir = path.join(pluginDir(plugin), "evals", "triggers");
    return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => ({ plugin, dir, c: e.name })) : [];
  });
  assert.ok(cases.length >= 10, cases.map((x) => x.c).join(", "));
  assert.equal(existsSync(path.join(ROOT, "evals")), false, "eval cases live in plugins/<plugin>/evals/, not evals/");
  for (const { plugin, dir, c } of cases) {
    assert.ok(existsSync(path.join(dir, c, "prompt.md")), `${c}: prompt.md missing`);
    const graders = readdirSync(path.join(dir, c, "graders"));
    assert.ok(graders.length, `${c}: no grader`);
    for (const g of graders) {
      const text = readFileSync(path.join(dir, c, "graders", g), "utf8");
      const m = /\(\?:\[\w-\]\+:\)\?([a-z0-9-]+)"/.exec(text);
      if (!m) continue;
      assert.equal(m[1], c, `${c}: grader targets ${m[1]}`);
      assert.equal(pluginOf(c), plugin, `${c}: the eval is in ${plugin}, the skill in ${pluginOf(c)}`);
      const fm = frontmatter(readFileSync(path.join(skillDir(c), "SKILL.md"), "utf8"));
      assert.notEqual(fm["disable-model-invocation"], "true", `${c} can't be invoked by Claude, so a trigger eval can't pass`);
    }
  }
});

test("the collection ships an Apache-2.0 LICENSE and NOTICE", () => {
  assert.match(readFileSync(path.join(ROOT, "LICENSE"), "utf8"), /Apache License\s+Version 2\.0, January 2004/);
  assert.ok(existsSync(path.join(ROOT, "NOTICE")), "NOTICE is missing");
  assert.equal(JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).license, "Apache-2.0");
});
