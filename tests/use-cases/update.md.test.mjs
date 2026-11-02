// Use case: tests/use-cases/update.md
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { REPO, skillDir, skillFile, skillModule } from "../../scripts/layout.mjs";

const { diagnose, graphifyDrift, hookCommands, isPlugin } = await skillModule("update", "scripts/doctor.mjs");
const { cloneRoot, detectMode, installedGroups, listedPlugins, parseArgs, parseRepo, plan, pluginSteps, readManifest, retiredSkills, skillGroups, skillsIn, versionOf } = await skillModule("update", "scripts/update.mjs");

const ROOT = REPO;
const UPDATE = skillFile("update", "scripts", "update.mjs");
const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
const git = (dir, ...a) => execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { encoding: "utf8" });
const linkDir = (src, dest) => symlinkSync(src, dest, process.platform === "win32" ? "junction" : "dir");
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

test("repo names come from URLs or owner/name", () => {
  assert.equal(parseRepo("https://github.com/acme/tools"), "acme/tools");
  assert.equal(parseRepo("git@github.com:acme/tools.git"), "acme/tools");
  assert.equal(parseRepo("acme/tools"), "acme/tools");
  assert.equal(parseRepo(""), null);
});

test("the plan refreshes installed skills, and adds new ones only with --all", () => {
  const groupOf = { a: "core", b: "core", c: "core" };
  const p = plan(["a", "b", "gone"], ["a", "b", "c"], { groups: ["core"], groupOf });
  assert.deepEqual(p.update, ["a", "b"]);
  assert.deepEqual(p.added, ["c"]);
  assert.deepEqual(p.removed, ["gone"]);
  assert.deepEqual(p.install, ["a", "b"]);
  assert.deepEqual(plan(["a"], ["a", "c"], { all: true, groups: ["core"], groupOf }).install, ["a", "c"]);
});

test("a skill the new version retired is split from ones it just stopped shipping", async () => {
  const p = plan(["a", "old", "gone"], ["a"], { retired: { old: "a --flag" } });
  assert.deepEqual(p.update, ["a"]);
  assert.deepEqual(p.retired, [{ name: "old", use: "a --flag" }]);
  assert.deepEqual(p.removed, ["gone"]);
  assert.deepEqual(plan(["a"], ["a"]).retired, []);
  // Read from the clone's own layout.mjs; a clone without one retires nothing.
  assert.equal((await retiredSkills(ROOT))["ship-plan"], "implement-to-pr --review-plan --merge");
  assert.deepEqual(await retiredSkills(tmp("cpt-no-layout-")), {});
});

test("new skills count only in the groups the install has; --all never adds graphify", () => {
  const groupOf = { fleet: "core", fresh: "core", "ux-mockup": "ui", deploy: "projects", graphify: "graphify" };
  const available = Object.keys(groupOf);
  const core = plan(["fleet"], available, { all: true, groups: ["core"], groupOf });
  assert.deepEqual(core.added, ["fresh"]);
  assert.deepEqual(core.install, ["fleet", "fresh"]);
  // graphify is new only for an install that has the graphify group.
  assert.deepEqual(plan(["fleet", "graphify"], available, { all: true, groups: ["core", "graphify"], groupOf }).added, ["fresh"]);
  assert.deepEqual(plan(["fleet"], available, { groups: ["core", "graphify"], groupOf }).added, ["fresh", "graphify"]);
  // A 0.5 clone has no groups, so nothing is new; no groups given, nothing is new either.
  assert.deepEqual(plan(["fleet"], available, { all: true, groups: ["core"] }).added, []);
  assert.deepEqual(plan(["fleet"], available).added, []);

  // The groups come from the manifest, or (an older manifest) from the installed skills.
  assert.deepEqual(installedGroups({ groups: ["core"] }, ["fleet", "ux-mockup"], groupOf), ["core"]);
  assert.deepEqual(installedGroups({ skills: ["ux-mockup", "fleet"] }, ["ux-mockup", "fleet"], groupOf), ["core", "ui"]);
  assert.deepEqual(installedGroups(null, ["fleet", "unknown"], groupOf), ["core"]);
});

test("the install mode comes from the manifest, the plugin cache, or a link", () => {
  assert.equal(detectMode(path.join(tmpdir(), "x", "plugins", "cache", "aidevgru", "power-tools", "0.6.0", "skills", "update"), null), "plugin");
  assert.equal(detectMode(tmpdir(), { mode: "link" }), "link");
  assert.equal(detectMode(path.join(tmpdir(), "no-such-skill"), null), "copy");
  // A linked install runs from the clone's real path, which has a plugins/ folder of its own.
  assert.equal(detectMode(path.join(tmpdir(), "clone", "plugins", "power-tools", "skills", "update"), { mode: "link" }), "link");
  assert.throws(() => parseArgs(["--bogus"]), /unknown option/);
  assert.deepEqual(parseArgs(["--force", "--all", "--ref", "v1"]).ref, "v1");
});

test("a clone is read in either layout: plugins/*/skills and extras (0.6), or skills (0.5)", () => {
  const now = tmp("cpt-up-layout-");
  write(path.join(now, "plugins", "power-tools", "skills", "alpha", "SKILL.md"), "x");
  write(path.join(now, "plugins", "power-tools-ui", "skills", "beta", "SKILL.md"), "x");
  write(path.join(now, "extras", "graphify", "SKILL.md"), "x");
  mkdirSync(path.join(now, "plugins", "power-tools", "skills", "leftover"), { recursive: true });
  write(path.join(now, "package.json"), JSON.stringify({ version: "0.6.0" }));
  assert.deepEqual(skillsIn(now), ["alpha", "beta", "graphify"]);
  assert.equal(versionOf(now), "0.6.0");

  const old = tmp("cpt-up-layout-old-");
  write(path.join(old, "skills", "alpha", "SKILL.md"), "x");
  write(path.join(old, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.5.0" }));
  assert.deepEqual(skillsIn(old), ["alpha"]);
  assert.equal(versionOf(old), "0.5.0");

  assert.equal(cloneRoot(skillDir("update")), ROOT);
});

test("a plugin update covers each of our plugins installed here, and installs only for the 0.5 rename", () => {
  const cmds = (listed) => pluginSteps(listed).steps.map(([, a]) => a.join(" "));
  const fallback = (listed) => pluginSteps(listed).steps.filter(([, , f]) => f?.installIfMissing).map(([, a]) => a[2]);
  const list = JSON.stringify([{ id: "power-tools@aidevgru", scope: "user", enabled: true }, { id: "power-tools-ui@aidevgru" }, { id: "other@elsewhere", scope: "user" }]);
  assert.deepEqual(listedPlugins(list), ["power-tools", "power-tools-ui"]);
  assert.deepEqual(listedPlugins("not json"), []);
  assert.deepEqual(cmds(listedPlugins(list)), ["plugin update power-tools@aidevgru", "plugin update power-tools-ui@aidevgru"]);
  // Not a migration: no list of missing plugins on every /update, and no install if an update fails.
  assert.deepEqual(pluginSteps(listedPlugins(list)).hints, []);
  assert.deepEqual(fallback(listedPlugins(list)), []);
  assert.deepEqual(fallback([]), []);

  // Rows of another project (often shown disabled here) and managed rows are not ours to update;
  // a project or local row of the project /update runs in is.
  const project = tmp("cpt-up-project-");
  const scoped = JSON.stringify([
    { id: "power-tools@aidevgru", scope: "user", enabled: true },
    { id: "power-tools-ui@aidevgru", scope: "project", enabled: false, projectPath: path.join(tmpdir(), "some-other-project") },
    { id: "power-tools-projects@aidevgru", scope: "managed", enabled: true },
  ]);
  assert.deepEqual(listedPlugins(scoped, project), ["power-tools"]);
  const local = JSON.stringify([{ id: "power-tools-ui@aidevgru", scope: "local", projectPath: project }]);
  assert.deepEqual(listedPlugins(local, path.join(project, "src")), ["power-tools-ui"]);

  // The 0.5 plugin: the rename moved its enabled setting to power-tools, but `claude plugin update
  // power-tools` reports it as not installed, so it is installed under the new name, and the
  // plugins that aren't installed are named once, for this migration.
  const old = listedPlugins(JSON.stringify([{ id: "claude-power-tools@aidevgru", scope: "user" }]));
  assert.deepEqual(old, ["claude-power-tools"]);
  assert.deepEqual(cmds(old), ["plugin install power-tools@aidevgru"]);
  const { hints } = pluginSteps(old);
  assert.match(hints.join("\n"), /Not installed here: power-tools-ui, power-tools-projects/);
  assert.match(hints.join("\n"), /claude plugin install power-tools-projects@aidevgru/);
  // Old record and power-tools both listed: the update may fall back to an install of power-tools only.
  assert.deepEqual(fallback(["claude-power-tools", "power-tools", "power-tools-ui"]), ["power-tools@aidevgru"]);
  assert.deepEqual(pluginSteps(["claude-power-tools", "power-tools", "power-tools-ui", "power-tools-projects"]).hints, []);
  // Nothing listed (the list failed): update the core plugin, which /update runs from.
  assert.deepEqual(cmds([]), ["plugin update power-tools@aidevgru"]);
});

// The files the 0.6 layout needs for the real installer to run from a fixture clone.
function newLayout(work, version) {
  copyFileSync(path.join(ROOT, "scripts", "install.mjs"), path.join(mkdirP(work, "scripts"), "install.mjs"));
  copyFileSync(path.join(ROOT, "scripts", "layout.mjs"), path.join(work, "scripts", "layout.mjs"));
  // The installer shares the doctor's graphify wording.
  copyFileSync(skillFile("update", "scripts", "doctor.mjs"), path.join(mkdirP(work, "plugins", "power-tools", "skills", "update", "scripts"), "doctor.mjs"));
  write(path.join(work, "plugins", "power-tools", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "power-tools", version, repository: "https://github.com/acme/tools" }));
  write(path.join(work, "plugins", "power-tools", "hooks", "hooks.json"), JSON.stringify({ hooks: {} }));
  write(path.join(work, "package.json"), JSON.stringify({ name: "claude-power-tools", version }));
}

function mkdirP(...p) {
  const dir = path.join(...p);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const newSkill = (work, name) => write(path.join(work, "plugins", "power-tools", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);

// A tiny collection with the real installer, published to a bare "origin".
function collection() {
  const work = tmp("cpt-up-src-");
  const origin = tmp("cpt-up-origin-");
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(work, "init", "-q", "-b", "main");
  newLayout(work, "1.0.0");
  newSkill(work, "alpha");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "v1");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "-u", "origin", "main");
  return { work, origin, version: (v) => newLayout(work, v), skill: (name) => newSkill(work, name) };
}

const update = (target, ...args) => spawnSync(process.execPath, [UPDATE, "--target", target, ...args], { encoding: "utf8" });

test("a linked install previews, fast-forwards, and adds new skills only with --all", async () => {
  const src = collection();
  const clone = tmp("cpt-up-clone-");
  execFileSync("git", ["clone", "-q", src.origin, clone]);
  const target = tmp("cpt-up-target-");
  execFileSync(process.execPath, [path.join(clone, "scripts", "install.mjs"), "--target", target, "--link", "--no-hooks"], { encoding: "utf8" });
  assert.equal(readManifest(target).mode, "link");
  assert.deepEqual(readManifest(target).skills, ["alpha"]);

  assert.deepEqual(readManifest(target).groups, ["core"]);

  // Upstream ships 1.1.0 with a new core skill, a new UI skill and graphify.
  src.version("1.1.0");
  src.skill("beta");
  write(path.join(src.work, "plugins", "power-tools-ui", "skills", "delta", "SKILL.md"), "---\nname: delta\n---\n");
  write(path.join(src.work, "extras", "graphify", "SKILL.md"), "---\nname: graphify\n---\n");
  git(src.work, "add", ".");
  git(src.work, "commit", "-q", "-m", "feat: beta");
  git(src.work, "push", "-q");

  const preview = update(target);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /feat: beta/);
  assert.match(preview.stdout, /Nothing changed/);
  assert.equal(existsSync(path.join(clone, "plugins", "power-tools", "skills", "beta")), false);

  const forced = update(target, "--force");
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /1\.0\.0 → 1\.1\.0/);
  // A core install is offered only the new core skill, not the UI skill or graphify.
  assert.match(forced.stdout, /New skills available \(add with --all\): beta\n/);
  assert.equal(existsSync(path.join(target, "skills", "beta")), false);
  assert.deepEqual(await skillGroups(clone), { alpha: "core", beta: "core", delta: "ui", graphify: "graphify" });

  const all = update(target, "--force", "--all");
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /Also installing new skills: beta\n/);
  assert.ok(lstatSync(path.join(target, "skills", "beta")).isSymbolicLink());
  for (const name of ["delta", "graphify"]) assert.equal(existsSync(path.join(target, "skills", name)), false, name);
  assert.deepEqual(readManifest(target).skills, ["alpha", "beta"]);
  assert.deepEqual(readManifest(target).groups, ["core"]);
});

test("a linked install from before the plugin split is pulled into the new layout and re-linked", () => {
  // 0.5: skills at the clone root, the version in .claude-plugin/plugin.json.
  const work = tmp("cpt-up-old-src-");
  const origin = tmp("cpt-up-old-origin-");
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(work, "init", "-q", "-b", "main");
  write(path.join(work, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "claude-power-tools", version: "0.5.0" }));
  write(path.join(work, ".gitignore"), "__pycache__/\n");
  for (const name of ["alpha", "gamma"]) write(path.join(work, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "v0.5");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "-u", "origin", "main");

  // Priya's linked 0.5 install of both skills, as the 0.5 installer left it.
  const clone = tmp("cpt-up-old-clone-");
  execFileSync("git", ["clone", "-q", origin, clone]);
  const target = tmp("cpt-up-old-target-");
  mkdirSync(path.join(target, "skills"));
  for (const name of ["alpha", "gamma"]) linkDir(path.join(clone, "skills", name), path.join(target, "skills", name));
  write(path.join(target, "claude-power-tools.json"), JSON.stringify({ name: "claude-power-tools", version: "0.5.0", mode: "link", source: clone.replaceAll("\\", "/"), skills: ["alpha", "gamma"] }));
  // An ignored leftover keeps one old folder alive after the move, without its SKILL.md.
  write(path.join(clone, "skills", "alpha", "__pycache__", "x.pyc"), "");

  // 0.6 moves the skills into plugins/ and ships the new installer.
  git(work, "rm", "-q", ".claude-plugin/plugin.json");
  mkdirSync(path.join(work, "plugins", "power-tools", "skills"), { recursive: true });
  for (const name of ["alpha", "gamma"]) git(work, "mv", `skills/${name}`, `plugins/power-tools/skills/${name}`);
  newLayout(work, "0.6.0");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "feat: split into plugins");
  git(work, "push", "-q");

  const r = update(target, "--force");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /0\.5\.0 → 0\.6\.0/);
  assert.match(r.stdout, /re-link 2 skill\(s\) to their new folders/);
  for (const name of ["alpha", "gamma"]) {
    const dest = path.join(target, "skills", name);
    assert.ok(lstatSync(dest).isSymbolicLink(), name);
    assert.equal(realpathSync(dest), realpathSync(path.join(clone, "plugins", "power-tools", "skills", name)), name);
    assert.ok(existsSync(path.join(dest, "SKILL.md")), name);
  }
  const m = readManifest(target);
  assert.equal(m.mode, "link");
  assert.equal(m.version, "0.6.0");
  assert.deepEqual(m.skills, ["alpha", "gamma"]);
});

test("a dirty clone is refused, never stashed", () => {
  const src = collection();
  const clone = tmp("cpt-up-clone-");
  execFileSync("git", ["clone", "-q", src.origin, clone]);
  const target = tmp("cpt-up-target-");
  execFileSync(process.execPath, [path.join(clone, "scripts", "install.mjs"), "--target", target, "--link", "--no-hooks"], { encoding: "utf8" });
  writeFileSync(path.join(clone, "plugins", "power-tools", "skills", "alpha", "SKILL.md"), "local experiment\n");
  const r = update(target, "--force");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /uncommitted changes/);
  assert.equal(git(clone, "stash", "list"), "");
});

// The real collection installed with --link into a fresh target, as the hooks see it.
function linkedInstall(skills) {
  const target = tmp("cpt-doc-target-");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "install.mjs"), "--target", target, "--link", "--skills", skills], { encoding: "utf8" });
  return target;
}

const doctor = (target, ...args) => {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: target };
  delete env.CLAUDE_PLUGIN_ROOT;
  return spawnSync(process.execPath, [path.join(target, "skills", "update", "scripts", "doctor.mjs"), ...args], { encoding: "utf8", env });
};

test("the doctor probes every installed hook through its link, and the hook stays silent when all is well", () => {
  const target = linkedInstall("update,git-guard,project,request-inbox,fleet-manager");
  const r = doctor(target);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /All 4 hooks respond \(git-guard, fleet-manager, request-inbox, project\)/);
  assert.equal(doctor(target, "--hook").stdout, "");
});

test("the doctor names a hook that doesn't run or isn't registered for an event it needs", async () => {
  const skills = tmp("cpt-doc-skills-");
  mkdirSync(path.join(skills, "project", "scripts"), { recursive: true });
  writeFileSync(path.join(skills, "project", "scripts", "projects.mjs"), "throw new Error('Cannot find module x');\n");
  mkdirSync(path.join(skills, "git-guard"));
  linkDir(path.join(skillDir("git-guard"), "scripts"), path.join(skills, "git-guard", "scripts"));
  const problems = await diagnose(skills, { hooks: {} });
  assert.deepEqual(problems.map((p) => p.skill), ["git-guard", "project"]);
  assert.match(problems[0].problem, /isn't registered in settings\.json for PreToolUse, PostToolUse, UserPromptSubmit/);
  assert.match(problems[1].problem, /doesn't run \(.*Cannot find module x/);
  // Plugin installs register hooks through hooks.json, so only the probe runs.
  assert.deepEqual((await diagnose(skills, null)).map((p) => p.skill), ["project"]);
  assert.ok(isPlugin(path.join("home", ".claude", "plugins", "cache", "cpt", "skills"), {}));
  assert.ok(!isPlugin(path.join("home", ".claude", "skills"), {}));
  // Run straight from a clone, the doctor isn't a plugin install either.
  assert.ok(!isPlugin(path.join("src", "claude-power-tools", "plugins", "power-tools", "skills"), {}));

  // Registered for one event isn't enough: the approvals hook (UserPromptSubmit) would be missing.
  const group = { hooks: [{ command: `node "${skills.replace(/\\/g, "/")}/git-guard/scripts/git-guard.mjs"` }] };
  const partial = { hooks: { PreToolUse: [group], PostToolUse: [group] } };
  assert.equal(hookCommands(partial).length, 2);
  assert.equal(hookCommands(partial, "UserPromptSubmit").length, 0);
  const [gap] = await diagnose(skills, partial);
  assert.equal(gap.skill, "git-guard");
  assert.match(gap.problem, /for UserPromptSubmit$/);
  const full = { hooks: { ...partial.hooks, UserPromptSubmit: [group] } };
  assert.deepEqual((await diagnose(skills, full)).map((p) => p.skill), ["project"]);
});

test("graphify version drift is reported in both directions", () => {
  assert.equal(graphifyDrift("0.9.97", "0.9.97"), null);
  assert.equal(graphifyDrift(null, "0.9.97"), null);
  assert.match(graphifyDrift("0.9.82", "0.9.97"), /older than the bundled skill 0\.9\.97: uv tool upgrade graphifyy/);
  assert.match(graphifyDrift("0.9.98", "0.9.97"), /newer than the bundled skill 0\.9\.97.*vendor\.mjs sync graphify --ref v0\.9\.98/);
  assert.match(graphifyDrift("0.10.0", "0.9.97"), /newer/);
});
