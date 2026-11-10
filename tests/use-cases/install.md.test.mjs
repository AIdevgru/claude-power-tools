// Use case: tests/use-cases/install.md
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { agentsFor, availableSkills, graphifyHint, install, MANIFEST, parseArgs as parse, readManifest } from "../../scripts/install.mjs";
import { REPO, skillDir, skillsInGroups } from "../../scripts/layout.mjs";

// Stub the graphify CLI probe so tests never spawn a real `graphify`.
const parseArgs = (argv) => ({ ...parse(argv), graphifyVersion: () => "99.0.0" });

const quiet = () => {};
const target = () => mkdtempSync(path.join(tmpdir(), "cpt-install-"));
const settingsOf = (dir) => JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"));
const commands = (s) => Object.values(s.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
// A plain install is the core group: the power-tools plugin's skills.
const defaults = () => skillsInGroups(["core"]);
const linkDir = (src, dest) => symlinkSync(src, dest, process.platform === "win32" ? "junction" : "dir");

test("a dry run lists the work and changes nothing", () => {
  const dir = target();
  const r = install({ ...parseArgs(["--target", dir]), dryRun: true }, quiet);
  assert.deepEqual(r.installed, defaults());
  for (const s of ["graphify", "impeccable", "ux-mockup", "new-project", "project"]) assert.ok(!r.installed.includes(s), s);
  for (const s of ["fleet-manager", "pr-dashboard", "implement-to-pr", "git-guard", "update"]) assert.ok(r.installed.includes(s), s);
  assert.ok(r.hooksAdded.length >= 6);
  assert.deepEqual(readdirSync(dir), []);
});

test("install keeps existing settings, appends our hooks, backs up, and is idempotent", () => {
  const dir = target();
  const mine = { permissions: { allow: ["Bash(npm *)"] }, hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "prettier --write" }] }] } };
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify(mine));
  const first = install(parseArgs(["--target", dir]), quiet);
  assert.ok(first.settingsBackup && existsSync(first.settingsBackup));
  const s = settingsOf(dir);
  assert.deepEqual(s.permissions, mine.permissions);
  assert.equal(s.hooks.PostToolUse[0].hooks[0].command, "prettier --write");
  const skillsDir = path.join(dir, "skills").replaceAll("\\", "/");
  assert.ok(s.hooks.UserPromptSubmit.some((g) => g.hooks[0].command === `node "${skillsDir}/fleet-manager/scripts/debounce.mjs"`));
  assert.ok(s.hooks.PreToolUse.some((g) => g.matcher === "Skill"));
  assert.ok(s.hooks.SessionStart.some((g) => g.hooks[0].command.endsWith('request-inbox/scripts/inbox.mjs" --hook')));
  // The project hook belongs to the projects group, which a plain install leaves out.
  assert.ok(!commands(s).some((c) => c.includes("projects.mjs")));
  assert.ok(s.hooks.SessionStart.some((g) => g.hooks[0].command.endsWith('update/scripts/doctor.mjs" --hook')));
  assert.ok(s.hooks.PreToolUse.some((g) => g.matcher === "Bash|PowerShell" && g.hooks[0].command.includes("git-guard.mjs")));
  assert.ok(s.hooks.PostToolUse.some((g) => g.matcher === "Edit|Write|MultiEdit|NotebookEdit"));
  const manifest = readManifest(dir);
  assert.equal(manifest.mode, "copy");
  assert.deepEqual(manifest.skills, defaults());
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(!commands(s).some((c) => c.includes("${CLAUDE_PLUGIN_ROOT}")));
  assert.ok(existsSync(path.join(dir, "skills", "pr-dashboard", "scripts", "pr_dashboard.py")));

  const before = readFileSync(path.join(dir, "settings.json"), "utf8");
  const second = install(parseArgs(["--target", dir]), quiet);
  assert.deepEqual(second.installed, []);
  assert.equal(second.skipped.length, defaults().length);
  assert.deepEqual(second.hooksAdded, []);
  assert.equal(readFileSync(path.join(dir, "settings.json"), "utf8"), before);
});

test("a skill subset only brings the hooks it needs", () => {
  const dir = target();
  const r = install(parseArgs(["--target", dir, "--skills", "pr-dashboard"]), quiet);
  assert.deepEqual(r.installed, ["pr-dashboard"]);
  assert.deepEqual(r.hooksAdded, []);
  assert.equal(existsSync(path.join(dir, "settings.json")), false);
});

test("--force replaces an existing skill and moves the old one out of skills/", () => {
  const dir = target();
  install(parseArgs(["--target", dir, "--skills", "combine-prs", "--no-hooks"]), quiet);
  const r = install(parseArgs(["--target", dir, "--skills", "combine-prs", "--no-hooks", "--force"]), quiet);
  assert.deepEqual(r.installed, ["combine-prs"]);
  assert.equal(r.backedUp.length, 1);
  assert.ok(existsSync(r.backedUp[0]));
  assert.match(r.backedUp[0], /\/backups\/claude-power-tools\/[^/]+\/skills\/combine-prs$/);
  // Only the live copy is left where Claude Code looks for skills.
  assert.deepEqual(readdirSync(path.join(dir, "skills")), ["combine-prs"]);
});

test("graphify is opt-in: --with adds it, and the manifest keeps every skill installed so far", () => {
  const dir = target();
  install(parseArgs(["--target", dir, "--skills", "fleet-status", "--no-hooks"]), quiet);
  const r = install(parseArgs(["--target", dir, "--with", "graphify", "--no-hooks"]), quiet);
  assert.ok(r.installed.includes("graphify"));
  assert.ok(r.skipped.includes("fleet-status"));
  assert.deepEqual(readManifest(dir).skills, [...defaults(), "graphify"].sort());
  assert.ok(existsSync(path.join(dir, MANIFEST)));
});

test("--with adds groups, --all is core + ui + projects, and graphify stays opt-in", () => {
  const dry = (...a) => install({ ...parseArgs(["--target", target(), ...a]), dryRun: true }, quiet);
  const ui = dry("--with", "ui");
  assert.deepEqual(ui.installed, [...defaults(), ...skillsInGroups(["ui"])].sort());
  assert.ok(ui.installed.includes("impeccable") && ui.installed.includes("ui-critique-loop"));
  assert.deepEqual(ui.agents, agentsFor(["impeccable", "screenreader"]));
  assert.ok(ui.agents.includes("screenreader-persona.md"), ui.agents.join(", "));
  const all = dry("--all");
  assert.deepEqual(all.installed, skillsInGroups(["core", "ui", "projects"]));
  assert.deepEqual(all.installed, availableSkills().filter((s) => s !== "graphify"));
  assert.ok(all.hooksAdded.some((h) => h.includes("projects.mjs")), "the projects group brings the project hook");
  assert.deepEqual(dry("--with", "ui,projects").installed, all.installed);
  assert.deepEqual(dry("--all", "--with", "graphify").installed, availableSkills());
  // A single skill still works with --with.
  assert.deepEqual(dry("--with", "deploy").installed, [...defaults(), "deploy"].sort());
  assert.throws(() => dry("--with", "nope"), /unknown skill\(s\) or group\(s\): nope/);
});

test("hooks merge one by one, so a partly installed group gains only what it lacks", () => {
  const dir = target();
  install(parseArgs(["--target", dir, "--skills", "request-inbox"]), quiet);
  const r = install(parseArgs(["--target", dir, "--skills", "request-inbox,project"]), quiet);
  assert.equal(r.hooksAdded.length, 1);
  assert.match(r.hooksAdded[0], /projects\.mjs/);
  const inbox = commands(settingsOf(dir)).filter((c) => c.includes("inbox.mjs"));
  assert.equal(inbox.length, 1);
});

test("--link links the skill folder instead of copying it", () => {
  const dir = target();
  install(parseArgs(["--target", dir, "--skills", "fleet-status", "--no-hooks", "--link"]), quiet);
  assert.ok(lstatSync(path.join(dir, "skills", "fleet-status")).isSymbolicLink());
  assert.ok(existsSync(path.join(dir, "skills", "fleet-status", "SKILL.md")));
});

test("scripts run through a linked skill folder still do their job", () => {
  const dir = target();
  install(parseArgs(["--target", dir, "--skills", "git-guard,project", "--no-hooks", "--link"]), quiet);
  const run = (script, args, input) => spawnSync(process.execPath, [path.join(dir, "skills", script), ...args], { input, encoding: "utf8", env: { ...process.env, GIT_GUARD_HOME: dir, POWER_TOOLS_HOME: dir } });
  const input = JSON.stringify({ hook_event_name: "PreToolUse", cwd: dir, tool_name: "Bash", tool_input: { command: "git push --force origin main" } });
  const hook = run("git-guard/scripts/git-guard.mjs", [], input);
  assert.equal(JSON.parse(hook.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(run("project/scripts/projects.mjs", ["roots"]).stdout, /\S/);
});

test("a linked install from before the plugin split is re-linked, recorded skills included", () => {
  const dir = target();
  // 0.5 linked <clone>/skills/<name>; the pull moved those folders, so the links dangle.
  const old = mkdtempSync(path.join(tmpdir(), "cpt-old-clone-"));
  mkdirSync(path.join(dir, "skills"));
  for (const name of ["fleet-status", "project"]) {
    mkdirSync(path.join(old, "skills", name), { recursive: true });
    writeFileSync(path.join(old, "skills", name, "SKILL.md"), "0.5\n");
    linkDir(path.join(old, "skills", name), path.join(dir, "skills", name));
  }
  writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ name: "claude-power-tools", version: "0.5.0", mode: "link", source: REPO, skills: ["fleet-status", "project"] }));
  for (const name of ["fleet-status", "project"]) rmSync(path.join(old, "skills", name, "SKILL.md"));

  const preview = install({ ...parseArgs(["--target", dir, "--skills", "fleet-status", "--no-hooks", "--link"]), dryRun: true }, quiet);
  assert.deepEqual(preview.relinked, ["fleet-status", "project"]);
  assert.equal(realpathSync(path.join(dir, "skills", "fleet-status")), realpathSync(path.join(old, "skills", "fleet-status")), "a dry run re-links nothing");

  const lines = [];
  // project isn't selected, but the manifest recorded it, so it is re-linked too.
  const r = install(parseArgs(["--target", dir, "--skills", "fleet-status", "--no-hooks", "--link"]), (l) => lines.push(l));
  assert.deepEqual(r.relinked, ["fleet-status", "project"]);
  assert.deepEqual(r.installed, []);
  assert.match(lines.join("\n"), /re-link 2 skill\(s\) to their new folders/);
  for (const name of ["fleet-status", "project"]) {
    const dest = path.join(dir, "skills", name);
    assert.ok(lstatSync(dest).isSymbolicLink(), name);
    assert.equal(realpathSync(dest), realpathSync(skillDir(name)), name);
  }
  const m = readManifest(dir);
  assert.equal(m.mode, "link");
  assert.deepEqual(m.skills, ["fleet-status", "project"]);

  const again = install(parseArgs(["--target", dir, "--skills", "fleet-status", "--no-hooks", "--link"]), quiet);
  assert.deepEqual(again.relinked, []);
  assert.deepEqual(again.skipped, ["fleet-status"]);
});

// A target whose recorded skills are links into an old clone layout that no longer exists.
function staleLinkedTarget(names) {
  const dir = target();
  const old = mkdtempSync(path.join(tmpdir(), "cpt-old-clone-"));
  mkdirSync(path.join(dir, "skills"));
  for (const name of names) {
    mkdirSync(path.join(old, "skills", name), { recursive: true });
    linkDir(path.join(old, "skills", name), path.join(dir, "skills", name));
  }
  writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ name: "claude-power-tools", version: "0.5.0", mode: "copy", source: REPO, skills: names }));
  return dir;
}

test("a copy run never links: a selected stale link becomes a copy, a recorded one is named", () => {
  // The source here could be a copy-mode /update's temporary download, about to be deleted.
  const dir = staleLinkedTarget(["fleet-status", "project"]);
  const lines = [];
  const r = install(parseArgs(["--target", dir, "--skills", "fleet-status", "--no-hooks"]), (l) => lines.push(l));
  assert.deepEqual(r.relinked, []);
  assert.deepEqual(r.installed, ["fleet-status"], "replaced without --force, because the link was stale");
  assert.deepEqual(r.replacedLinks, ["fleet-status"]);
  assert.equal(r.backedUp.length, 1);
  const dest = path.join(dir, "skills", "fleet-status");
  assert.ok(!lstatSync(dest).isSymbolicLink(), "a real copy, not a link into the source");
  assert.ok(existsSync(path.join(dest, "SKILL.md")));
  // project wasn't selected: its stale link is left alone, and named.
  assert.deepEqual(r.staleLinks, ["project"]);
  assert.ok(lstatSync(path.join(dir, "skills", "project")).isSymbolicLink());
  assert.match(lines.join("\n"), /left alone: 1 recorded skill\(s\) whose link is stale \(project\).*--link/);
  assert.equal(readManifest(dir).mode, "copy");
});

// A target whose manifest records ship-plan (retired in 0.7.0) next to fleet-status, with
// ship-plan installed by `make(dest)`.
function retiredTarget(make, mode) {
  const dir = target();
  mkdirSync(path.join(dir, "skills"));
  make(path.join(dir, "skills", "ship-plan"));
  writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ name: "claude-power-tools", version: "0.6.0", mode, source: REPO, skills: ["fleet-status", "ship-plan"] }));
  return dir;
}

test("a recorded retired skill is removed: a link is unlinked, a copy is backed up, both leave the manifest", () => {
  // Linked: the link goes, the folder it pointed at stays.
  const old = mkdtempSync(path.join(tmpdir(), "cpt-old-clone-"));
  writeFileSync(path.join(old, "SKILL.md"), "0.6\n");
  const linked = retiredTarget((dest) => linkDir(old, dest), "link");
  const preview = install({ ...parseArgs(["--target", linked, "--skills", "fleet-status", "--no-hooks", "--link"]), dryRun: true }, quiet);
  assert.deepEqual(preview.retired, ["ship-plan"]);
  assert.ok(lstatSync(path.join(linked, "skills", "ship-plan")).isSymbolicLink(), "a dry run removes nothing");
  const lines = [];
  const r = install(parseArgs(["--target", linked, "--skills", "fleet-status", "--no-hooks", "--link"]), (l) => lines.push(l));
  assert.deepEqual(r.retired, ["ship-plan"]);
  assert.ok(!existsSync(path.join(linked, "skills", "ship-plan")) && !readdirSync(path.join(linked, "skills")).includes("ship-plan"), "the link is gone");
  assert.ok(existsSync(path.join(old, "SKILL.md")), "what the link pointed at is untouched");
  assert.deepEqual(r.backedUp, []);
  assert.match(lines.join("\n"), /remove retired skill ship-plan \(use \/implement-to-pr --review-plan --merge\)/);
  assert.deepEqual(readManifest(linked).skills, ["fleet-status"]);

  // Copied: the real folder moves to the backups, never deleted. No --force and nothing to
  // install (fleet-status isn't selected) still removes it and rewrites the manifest.
  const copied = retiredTarget((dest) => {
    mkdirSync(dest);
    writeFileSync(path.join(dest, "SKILL.md"), "0.6 copy\n");
  }, "copy");
  const c = install(parseArgs(["--target", copied, "--skills", "", "--no-hooks"]), quiet);
  assert.deepEqual(c.retired, ["ship-plan"]);
  assert.ok(!existsSync(path.join(copied, "skills", "ship-plan")));
  assert.equal(c.backedUp.length, 1);
  assert.match(c.backedUp[0], /backups\/claude-power-tools\/[^/]+\/skills\/ship-plan$/);
  assert.equal(readFileSync(path.join(c.backedUp[0], "SKILL.md"), "utf8"), "0.6 copy\n");
  assert.deepEqual(readManifest(copied).skills, ["fleet-status"]);

  // Not recorded: someone's own ship-plan folder is left alone.
  const mine = target();
  mkdirSync(path.join(mine, "skills", "ship-plan"), { recursive: true });
  const n = install(parseArgs(["--target", mine, "--skills", "fleet-status", "--no-hooks"]), quiet);
  assert.deepEqual(n.retired, []);
  assert.ok(existsSync(path.join(mine, "skills", "ship-plan")));
});

test("--force in a copy run turns a working link into a copy, so the manifest's mode is what is on disk", () => {
  const dir = target();
  install(parseArgs(["--target", dir, "--skills", "fleet-status", "--no-hooks", "--link"]), quiet);
  assert.ok(lstatSync(path.join(dir, "skills", "fleet-status")).isSymbolicLink());
  const r = install(parseArgs(["--target", dir, "--skills", "fleet-status", "--no-hooks", "--force"]), quiet);
  assert.deepEqual(r.installed, ["fleet-status"]);
  assert.deepEqual(r.relinked, []);
  assert.ok(!lstatSync(path.join(dir, "skills", "fleet-status")).isSymbolicLink());
  assert.equal(readManifest(dir).mode, "copy");
});

test("the manifest records the groups asked for by name, and infers them for an older manifest", () => {
  const dir = target();
  install(parseArgs(["--target", dir, "--no-hooks"]), quiet);
  assert.deepEqual(readManifest(dir).groups, ["core"]);
  install(parseArgs(["--target", dir, "--with", "graphify", "--no-hooks"]), quiet);
  assert.deepEqual(readManifest(dir).groups, ["core", "graphify"]);

  // --skills names no group.
  const one = target();
  install(parseArgs(["--target", one, "--skills", "impeccable", "--no-hooks"]), quiet);
  assert.deepEqual(readManifest(one).groups, []);

  // A manifest from before groups were recorded gets them from its skills.
  const old = target();
  writeFileSync(path.join(old, MANIFEST), JSON.stringify({ name: "claude-power-tools", version: "0.5.0", mode: "copy", skills: ["fleet-status", "ux-mockup"] }));
  install(parseArgs(["--target", old, "--skills", "pr-dashboard", "--no-hooks"]), quiet);
  assert.deepEqual(readManifest(old).groups, ["core", "ui"]);
});

test("a link to another working copy is left alone without --force", () => {
  const dir = target();
  const other = mkdtempSync(path.join(tmpdir(), "cpt-other-copy-"));
  writeFileSync(path.join(other, "SKILL.md"), "someone else's fleet-status\n");
  mkdirSync(path.join(dir, "skills"));
  linkDir(other, path.join(dir, "skills", "fleet-status"));
  const r = install(parseArgs(["--target", dir, "--skills", "fleet-status", "--no-hooks"]), quiet);
  assert.deepEqual(r.relinked, []);
  assert.deepEqual(r.skipped, ["fleet-status"]);
  assert.equal(realpathSync(path.join(dir, "skills", "fleet-status")), realpathSync(other));
});

test("invalid settings.json stops the install instead of overwriting it", () => {
  const dir = target();
  writeFileSync(path.join(dir, "settings.json"), "{ not json");
  assert.throws(() => install(parseArgs(["--target", dir]), quiet), /not valid JSON/);
  assert.equal(readFileSync(path.join(dir, "settings.json"), "utf8"), "{ not json");
});

test("unknown skills and options are rejected", () => {
  assert.throws(() => install(parseArgs(["--target", target(), "--skills", "nope"]), quiet), /unknown skill/);
  assert.throws(() => parse(["--bogus"]), /unknown option/);
});

test("Impeccable's agents are installed next to the skills, pointing at the installed skill", () => {
  const dir = target();
  const r = install(parseArgs(["--target", dir, "--skills", "impeccable", "--no-hooks"]), quiet);
  assert.deepEqual(r.installed, ["impeccable"]);
  assert.deepEqual(r.agents, agentsFor(["impeccable"]));
  assert.ok(r.agents.length >= 4);
  const text = readFileSync(path.join(dir, "agents", "impeccable-asset-producer.md"), "utf8");
  assert.ok(!text.includes("${CLAUDE_PLUGIN_ROOT}"));
  assert.ok(text.includes(`${dir.replaceAll("\\", "/")}/skills/impeccable/scripts/impeccable`));
  assert.ok(existsSync(path.join(dir, "skills", "impeccable", "scripts", "impeccable")));

  // A second run skips the skill and its agents; --force backs both up and replaces them.
  const again = install(parseArgs(["--target", dir, "--skills", "impeccable", "--no-hooks"]), quiet);
  assert.deepEqual(again.skipped, ["impeccable"]);
  assert.deepEqual(again.agents, []);
  const forced = install(parseArgs(["--target", dir, "--skills", "impeccable", "--no-hooks", "--force"]), quiet);
  assert.equal(forced.agents.length, r.agents.length);
  assert.equal(forced.backedUp.length, 1 + r.agents.length);
});

test("skills without agents install none", () => {
  const dir = target();
  const r = install(parseArgs(["--target", dir, "--skills", "fleet-status", "--no-hooks"]), quiet);
  assert.deepEqual(r.agents, []);
  assert.equal(existsSync(path.join(dir, "agents")), false);
});

test("graphify gets a hint when its Python CLI is missing or older than the skill", () => {
  assert.match(graphifyHint(null, "0.9.96"), /uv tool install graphifyy/);
  assert.match(graphifyHint("0.9.82", "0.9.96"), /older than the bundled skill 0\.9\.96: uv tool upgrade graphifyy/);
  assert.equal(graphifyHint("0.9.96", "0.9.96"), null);
  assert.match(graphifyHint("0.10.0", "0.9.96"), /newer than the bundled skill 0\.9\.96.*Run \/update/);

  const missing = install({ ...parse(["--target", target(), "--skills", "graphify", "--no-hooks"]), graphifyVersion: () => null }, quiet);
  assert.deepEqual(missing.installed, ["graphify"]);
  assert.equal(missing.notes.length, 1);
  const current = install({ ...parse(["--target", target(), "--skills", "graphify", "--no-hooks"]), graphifyVersion: () => "0.9.97" }, quiet);
  assert.deepEqual(current.notes, []);
});

test("agents are not installed for a skill that was skipped as already installed", () => {
  const dir = target();
  mkdirSync(path.join(dir, "skills", "impeccable"), { recursive: true });
  writeFileSync(path.join(dir, "skills", "impeccable", "SKILL.md"), "an older copy\n");
  const r = install(parseArgs(["--target", dir, "--skills", "impeccable", "--no-hooks"]), quiet);
  assert.deepEqual(r.skipped, ["impeccable"]);
  assert.deepEqual(r.agents, []);
  assert.equal(existsSync(path.join(dir, "agents")), false);
});
