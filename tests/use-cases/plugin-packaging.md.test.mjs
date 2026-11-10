// Use case: tests/use-cases/plugin-packaging.md
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { claudeCommand, evalRuns } from "../../scripts/eval.mjs";
import { EXTRAS, PLUGINS, pluginDir, pluginHooks, pluginOf, pluginSkills, REPO, skillDir, skillMap, skillNames } from "../../scripts/layout.mjs";

const rel = (p) => path.relative(REPO, p).replaceAll("\\", "/");
const readJson = (...p) => JSON.parse(readFileSync(path.join(...p), "utf8"));
const inside = (child, parent) => {
  const r = path.relative(parent, child);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
};

// Every text file under dir.
function textFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "__pycache__", "results"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) textFiles(p, out);
    else if (/\.(md|mjs|js|cjs|json|py|txt|ya?ml|sh|cmd)$/.test(e.name)) out.push(p);
  }
  return out;
}

const VENDORED = new Set(Object.values(readJson(REPO, "vendor.lock.json")).flatMap((l) => Object.keys(l.files)));
const firstParty = (file) => !VENDORED.has(rel(file));

// The split the release plan settled on.
const EXPECTED = {
  "power-tools": ["all", "combine-prs", "drain-pr-queue", "finish-pr", "fleet-manager", "fleet-status", "git-guard", "implement-to-pr", "issues-to-plan", "pr-dashboard", "request-inbox", "ticket-to-pr", "ticket-triage", "update", "usage-handoff"],
  "power-tools-ui": ["impeccable", "ui-critique-loop", "ui-finalize", "ux-mockup", "video"],
  "power-tools-projects": ["deploy", "new-project", "project"],
};

test("every skill is in exactly one plugin, and layout.mjs agrees with the folders", () => {
  assert.deepEqual(Object.keys(PLUGINS).sort(), Object.keys(EXPECTED).sort());
  for (const [plugin, skills] of Object.entries(EXPECTED)) assert.deepEqual(pluginSkills(plugin), skills, plugin);
  const all = Object.values(EXPECTED).flat();
  assert.equal(new Set(all).size, all.length, "a skill is listed in two plugins");
  assert.deepEqual(skillNames(), [...all, ...Object.keys(EXTRAS)].sort());
  for (const name of all) assert.ok(inside(skillDir(name), pluginDir(pluginOf(name))), name);

  // No folder that layout.mjs would silently skip: every plugin folder is listed, and every
  // folder under a plugin's skills/ (and under extras/) is a skill.
  assert.deepEqual(readdirSync(path.join(REPO, "plugins")).sort(), Object.values(PLUGINS).map((p) => path.basename(p.dir)).sort());
  for (const plugin of Object.keys(PLUGINS)) {
    const dir = path.join(pluginDir(plugin), "skills");
    for (const name of readdirSync(dir)) assert.ok(existsSync(path.join(dir, name, "SKILL.md")), `${rel(dir)}/${name} has no SKILL.md`);
  }
  for (const name of readdirSync(path.join(REPO, "extras"))) assert.ok(name in EXTRAS, `extras/${name} isn't in layout.mjs EXTRAS`);
  // The pre-0.6 folders are gone.
  for (const old of ["skills", "agents", "hooks", "evals"]) assert.ok(!existsSync(path.join(REPO, old)), `${old}/ is back at the repo root`);
});

test("the marketplace serves the three plugin folders and renames the old plugin", () => {
  const market = readJson(REPO, ".claude-plugin", "marketplace.json");
  assert.equal(market.name, "aidevgru");
  assert.deepEqual(market.renames, { "claude-power-tools": "power-tools" });
  assert.deepEqual(market.plugins.map((p) => p.name).sort(), Object.keys(PLUGINS).sort());
  for (const entry of market.plugins) {
    assert.equal(entry.source, `./${PLUGINS[entry.name].dir}`, entry.name);
    assert.ok(entry.description, entry.name);
    assert.equal(readJson(pluginDir(entry.name), ".claude-plugin", "plugin.json").name, entry.name);
  }
});

test("each plugin's hooks run scripts inside that plugin, and only power-tools-ui has agents", () => {
  const scripts = {};
  for (const plugin of Object.keys(PLUGINS)) {
    scripts[plugin] = [];
    for (const group of Object.values(pluginHooks(plugin).hooks).flat()) {
      for (const h of group.hooks) {
        const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/.exec(h.command);
        assert.ok(m, `${plugin}: ${h.command}`);
        const file = path.join(pluginDir(plugin), m[1]);
        assert.ok(inside(file, pluginDir(plugin)) && existsSync(file), `${plugin}: ${h.command}`);
        scripts[plugin].push(m[1].split("/")[1]);
      }
    }
  }
  assert.deepEqual([...new Set(scripts["power-tools"])].sort(), ["fleet-manager", "git-guard", "request-inbox", "update", "usage-handoff"]);
  assert.deepEqual(scripts["power-tools-ui"], []);
  assert.deepEqual(scripts["power-tools-projects"], ["project"]);
  assert.ok(!existsSync(path.join(pluginDir("power-tools-ui"), "hooks", "hooks.json")), "power-tools-ui registers no hooks");

  for (const plugin of Object.keys(PLUGINS)) {
    const agents = path.join(pluginDir(plugin), "agents");
    if (plugin !== "power-tools-ui") assert.ok(!existsSync(agents), `${plugin} has agents`);
  }
  const agents = readdirSync(path.join(pluginDir("power-tools-ui"), "agents"));
  assert.equal(agents.length, 4);
  for (const a of agents) assert.match(a, /^impeccable-.+\.md$/);
});

test("no file in a plugin reaches outside its plugin folder with ../", () => {
  const problems = [];
  for (const plugin of Object.keys(PLUGINS)) {
    const root = pluginDir(plugin);
    for (const file of textFiles(root)) {
      const text = readFileSync(file, "utf8");
      const here = path.dirname(file);
      // Markdown links and quoted relative paths resolve against the file's own folder.
      for (const [, target] of text.matchAll(/\]\((\.\.\/[^)\s#]*)\)/g)) {
        if (!inside(path.resolve(here, target), root)) problems.push(`${rel(file)}: link ${target}`);
      }
      for (const [, target] of text.matchAll(/["'](\.\.\/[^"'\s$]*)["']/g)) {
        if (!inside(path.resolve(here, target), root)) problems.push(`${rel(file)}: path ${target}`);
      }
      // "<SKILL_DIR>/../<skill>/..." (or the skill's base directory) names a sibling skill,
      // which must ship in the same plugin.
      for (const [, sibling] of text.matchAll(/(?:SKILL_DIR|base directory|base dir)>\/\.\.\/([\w-]+)\//g)) {
        if (pluginOf(sibling) !== plugin) problems.push(`${rel(file)}: uses ../${sibling}/, which is in ${pluginOf(sibling) ?? "no plugin"}`);
      }
    }
    for (const json of [path.join(root, ".claude-plugin", "plugin.json"), path.join(root, "hooks", "hooks.json")]) {
      if (existsSync(json) && readFileSync(json, "utf8").includes("../")) problems.push(`${rel(json)} has a ../ path`);
    }
  }
  assert.deepEqual(problems, []);
});

test("every <plugin>:<skill> name points at the plugin that ships the skill", () => {
  const files = [...Object.keys(PLUGINS).flatMap((p) => textFiles(pluginDir(p))), ...textFiles(path.join(REPO, "docs")).filter((f) => !f.includes(`${path.sep}plans${path.sep}`))];
  const problems = [];
  for (const file of files.filter(firstParty)) {
    const text = readFileSync(file, "utf8");
    for (const [ref, prefix, skill] of text.matchAll(/\b(claude-power-tools|power-tools(?:-ui|-projects)?):([a-z0-9][a-z0-9-]*)/g)) {
      if (!(skill in skillMap())) continue;
      if (prefix !== pluginOf(skill)) problems.push(`${rel(file)}: ${ref} (the skill is in ${pluginOf(skill) ?? "no plugin"})`);
    }
  }
  assert.deepEqual(problems, []);
});

test("a skill that calls a skill from another plugin says which plugin to install", () => {
  const problems = [];
  for (const plugin of Object.keys(PLUGINS)) {
    for (const file of textFiles(pluginDir(plugin)).filter(firstParty).filter((f) => f.endsWith(".md"))) {
      const text = readFileSync(file, "utf8");
      const others = new Set([...text.matchAll(/\b(power-tools(?:-ui|-projects)?):[a-z0-9-]+/g)].map((m) => m[1]).filter((p) => p !== plugin));
      for (const other of others) {
        if (!new RegExp(`\`${other}\` plugin|the ${other} plugin`).test(text)) problems.push(`${rel(file)} calls into ${other} without saying to install it`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("npm run eval runs claude plugin eval once per plugin, on that plugin's folder", () => {
  assert.equal(readJson(REPO, "package.json").scripts.eval, "node scripts/eval.mjs");
  assert.deepEqual(evalRuns([]).map((a) => a[2]), Object.values(PLUGINS).map((p) => p.dir));
  assert.deepEqual(evalRuns(["power-tools-ui", "--", "--case", "ux-mockup"]), [["plugin", "eval", "plugins/power-tools-ui", "--tag", "trigger", "--ablation", "none", "--case", "ux-mockup"]]);
  assert.throws(() => evalRuns(["nope"]), /unknown plugin/);
  assert.throws(() => evalRuns(["toString"]), /unknown plugin/, "prototype names aren't plugins");

  // claude starts without a shell where it can: claude.exe directly, claude.cmd as one quoted line.
  const win = (files) => (args) => claudeCommand(args, { platform: "win32", env: { PATH: "C:\\bin", PATHEXT: ".EXE;.CMD" }, exists: (f) => files.includes(f) });
  assert.deepEqual(win(["C:\\bin\\claude.exe"])(["a b"]), { file: "C:\\bin\\claude.exe", args: ["a b"], shell: false });
  assert.deepEqual(win(["C:\\bin\\claude.cmd"])(["plugin", "a b&c", "x\\"]), { file: '"C:\\bin\\claude.cmd" "plugin" "a b&c" "x\\\\"', args: [], shell: true });
  assert.throws(() => win(["C:\\bin\\claude.cmd"])(["%PATH%"]), /cmd\.exe/);
  assert.throws(() => win([])(["x"]), /not on PATH/);
  assert.deepEqual(claudeCommand(["x"], { platform: "linux" }), { file: "claude", args: ["x"], shell: false });
});

test("graphify is in no plugin: it ships only through the installer", () => {
  assert.equal(pluginOf("graphify"), null);
  assert.equal(skillMap().graphify.dir, "extras/graphify");
  assert.ok(existsSync(path.join(REPO, "extras", "graphify", "SKILL.md")));
  for (const plugin of Object.keys(PLUGINS)) assert.ok(!existsSync(path.join(pluginDir(plugin), "skills", "graphify")), plugin);
  const market = readFileSync(path.join(REPO, ".claude-plugin", "marketplace.json"), "utf8");
  assert.ok(!market.includes("graphify"), "the marketplace mentions graphify");
});
