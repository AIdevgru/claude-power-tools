// Use case: tests/use-cases/enhancement-switches.md
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applySettingDefaults, install, parseArgs as parse, SETTING_DEFAULTS } from "../../scripts/install.mjs";
import { skillDir, skillFile, skillModule } from "../../scripts/layout.mjs";

// Nothing here reads the real login or writes the real state folder.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "switches-cfg-"));
process.env.USAGE_HANDOFF_HOME = mkdtempSync(path.join(tmpdir(), "switches-"));
delete process.env.USAGE_HANDOFF_FIXTURE;
delete process.env.USAGE_HANDOFF_CMD;
const m = await skillModule("usage-handoff", "scripts/usage.mjs");
const SCRIPT = skillFile("usage-handoff", "scripts", "usage.mjs");

const parseArgs = (argv) => ({ ...parse(argv), graphifyVersion: () => "99.0.0" });
const target = () => mkdtempSync(path.join(tmpdir(), "switches-install-"));
const settingsOf = (dir) => JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"));
const quiet = () => {};

const T0 = Date.UTC(2026, 10, 1, 20, 0, 0);
const MIN = 60_000;
const WORK = { key: "u1/o2", email: "lee@acme.dev" };
const cache = { at: T0, account: WORK, windows: [{ name: "five_hour", pct: 64, resetsAt: T0 + 30 * MIN }] };
const book = { current: "u1/o2", accounts: { "u1/o1": {}, "u1/o2": {} } };
const soon = () => m.localTime(T0 + 30 * MIN, T0);
const on = { model: true, email: true, usage: true };

// Runs usage.mjs with its own state and config folders; returns { code, out, home, cfg }.
function usage(args, { home = mkdtempSync(path.join(tmpdir(), "switches-home-")), cfg = mkdtempSync(path.join(tmpdir(), "switches-cfg-")) } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, USAGE_HANDOFF_HOME: home, CLAUDE_CONFIG_DIR: cfg } });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trim(), home, cfg };
}

test("an install turns Remote Control on for every new session, and says how to turn it off", () => {
  const dir = target();
  const lines = [];
  const r = install(parseArgs(["--target", dir]), (l) => lines.push(l));
  assert.equal(settingsOf(dir).remoteControlAtStartup, true);
  assert.deepEqual(r.settingsSet.map((s) => [s.key, s.value]), [["remoteControlAtStartup", true]]);
  assert.ok(lines.some((l) => l.includes("set remoteControlAtStartup: true") && l.includes("--no-remote-control")), lines.join("\n"));

  const before = readFileSync(path.join(dir, "settings.json"), "utf8");
  const again = install(parseArgs(["--target", dir]), quiet);
  assert.deepEqual(again.settingsSet, []);
  assert.equal(again.settingsBackup, null, "nothing to change, nothing backed up");
  assert.equal(readFileSync(path.join(dir, "settings.json"), "utf8"), before, "a second run changes nothing");
});

test("a value the owner set stays; --no-remote-control stores false, even over true", () => {
  const mine = target();
  writeFileSync(path.join(mine, "settings.json"), JSON.stringify({ remoteControlAtStartup: false, theme: "dark" }));
  const kept = install(parseArgs(["--target", mine]), quiet);
  assert.deepEqual(kept.settingsSet, []);
  assert.deepEqual([settingsOf(mine).remoteControlAtStartup, settingsOf(mine).theme], [false, "dark"]);

  const sam = target();
  install(parseArgs(["--target", sam, "--no-remote-control"]), quiet);
  assert.equal(settingsOf(sam).remoteControlAtStartup, false);
  const flipped = target();
  install(parseArgs(["--target", flipped]), quiet);
  const r = install(parseArgs(["--target", flipped, "--no-remote-control"]), quiet);
  assert.equal(settingsOf(flipped).remoteControlAtStartup, false);
  assert.ok(r.settingsBackup && existsSync(r.settingsBackup), "the old settings are backed up first");
  // /config's "default" removes the key, so the next run turns it on again.
  writeFileSync(path.join(flipped, "settings.json"), JSON.stringify({ ...settingsOf(flipped), remoteControlAtStartup: undefined }));
  install(parseArgs(["--target", flipped]), quiet);
  assert.equal(settingsOf(flipped).remoteControlAtStartup, true);
});

test("the default comes with the core group: a one-skill install leaves it, /update of a core install sets it", () => {
  const one = target();
  const r = install(parseArgs(["--target", one, "--skills", "pr-dashboard"]), quiet);
  assert.deepEqual(r.settingsSet, []);
  assert.ok(!existsSync(path.join(one, "settings.json")), "only the skill");
  install(parseArgs(["--target", one, "--skills", "pr-dashboard", "--no-remote-control"]), quiet);
  assert.equal(settingsOf(one).remoteControlAtStartup, false, "an explicit flag is still written");

  // /update reruns the installer with --skills; the manifest's recorded core group brings the default.
  const core = target();
  install(parseArgs(["--target", core, "--no-hooks"]), quiet);
  const upd = install(parseArgs(["--target", core, "--skills", "fleet-status", "--force"]), quiet);
  assert.deepEqual(upd.settingsSet.map((s) => s.key), ["remoteControlAtStartup"]);
  assert.equal(settingsOf(core).remoteControlAtStartup, true);
});

test("only a recorded core group brings the default, not one guessed from an older manifest's skills", () => {
  const dir = target();
  install(parseArgs(["--target", dir, "--skills", "pr-dashboard,update", "--no-hooks"]), quiet);
  const file = path.join(dir, "claude-power-tools.json");
  const { groups, ...old } = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify(old)); // a manifest from before groups were recorded
  const r = install(parseArgs(["--target", dir, "--skills", "pr-dashboard,update", "--force"]), quiet);
  assert.deepEqual(r.settingsSet, [], "pr-dashboard and update are core skills, but nobody asked for core");
  assert.equal(existsSync(path.join(dir, "settings.json")) && Object.hasOwn(settingsOf(dir), "remoteControlAtStartup"), false);
});

test("--no-remote-control is written even with --no-hooks, so a later /update keeps it off", () => {
  const dir = target();
  const lines = [];
  const r = install(parseArgs(["--target", dir, "--no-hooks", "--no-remote-control"]), (l) => lines.push(l));
  assert.deepEqual(settingsOf(dir), { remoteControlAtStartup: false }, "only the asked-for setting, no hooks");
  assert.deepEqual(r.hooksAdded, []);
  assert.ok(lines.some((l) => l.startsWith("set remoteControlAtStartup: false")), lines.join("\n"));
  assert.ok(!lines.some((l) => l.startsWith("hooks:")), "no word about hooks it was told to leave alone");
  const upd = install(parseArgs(["--target", dir, "--skills", "fleet-status", "--force"]), quiet);
  assert.deepEqual(upd.settingsSet, []);
  assert.equal(settingsOf(dir).remoteControlAtStartup, false);
});

test("--no-hooks leaves settings.json alone, and a dry run only reports the setting", () => {
  const dir = target();
  install(parseArgs(["--target", dir, "--no-hooks"]), quiet);
  assert.ok(!existsSync(path.join(dir, "settings.json")));
  const lines = [];
  const r = install({ ...parseArgs(["--target", dir]), dryRun: true }, (l) => lines.push(l));
  assert.deepEqual(r.settingsSet.map((s) => s.key), ["remoteControlAtStartup"]);
  assert.ok(lines.some((l) => l.startsWith("[dry run] would set remoteControlAtStartup")), lines.join("\n"));
  assert.ok(!existsSync(path.join(dir, "settings.json")));
});

test("the defaults are one table, and applying them is a pure merge", () => {
  assert.deepEqual(SETTING_DEFAULTS.map((d) => [d.key, d.on, d.off, d.flag]), [["remoteControlAtStartup", true, false, "remote-control"]]);
  const s = { hooks: {} };
  const { settings, set } = applySettingDefaults(s);
  assert.deepEqual(s, { hooks: {} }, "the input isn't changed");
  assert.equal(settings.remoteControlAtStartup, true);
  assert.equal(set.length, 1);
  assert.deepEqual(applySettingDefaults({ remoteControlAtStartup: false }, ["remote-control"]).set, [], "already off");
  assert.deepEqual(applySettingDefaults({}, [], { defaults: false }).set, [], "no core group, no flag: nothing");
  assert.deepEqual(parse(["--no-remote-control"]).off, ["remote-control"]);
  assert.throws(() => parse(["--no-remote-controls"]), /unknown option/);
});

test("the status line's parts are all on by default, and each can be left out", () => {
  assert.deepEqual(m.showSettings({}), on);
  assert.deepEqual(m.showSettings({ show: { email: false } }), { ...on, email: false });
  const line = (show) => m.statusText({ cache, book, now: T0, model: "Opus 5.5", show });
  assert.equal(line(on), `Opus 5.5 · lee@acme.dev (+1) · 5h 64% (resets ${soon()})`);
  assert.equal(m.statusText({ cache, book, now: T0, model: "Opus 5.5" }), line(on), "no show given: everything");
  assert.equal(line({ ...on, email: false }), `Opus 5.5 · 5h 64% (resets ${soon()})`, "the account count goes with the email");
  assert.equal(line({ ...on, model: false }), `lee@acme.dev (+1) · 5h 64% (resets ${soon()})`);
  assert.equal(line({ ...on, usage: false }), "Opus 5.5 · lee@acme.dev (+1)");
  assert.equal(line({ model: false, email: false, usage: false }), "");
  assert.equal(m.statusText({ cache, book, now: T0, show: { model: false, email: false, usage: false }, link: "file:///x" }), "", "an empty line isn't wrapped in a link");

  const loggedOut = { at: T0, error: "not logged in", account: null };
  assert.equal(m.statusText({ cache: loggedOut, book, now: T0, show: { ...on, usage: false } }), "2 accounts");
  assert.equal(m.statusText({ cache: loggedOut, book, now: T0, show: { ...on, email: false } }), "usage: not logged in");
  const old = { ...cache, at: T0 - 20 * MIN };
  assert.match(m.statusText({ cache: old, now: T0 }), /· 20 min old$/);
  assert.equal(m.statusText({ cache: old, now: T0, show: { ...on, usage: false } }), "lee@acme.dev", "the age is about the usage");
  const handoff = { phase: "handoff", resumeAt: new Date(T0 + 30 * MIN).toISOString(), threshold: 95 };
  assert.match(m.statusText({ cache, state: handoff, now: T0, show: { ...on, usage: false } }), /^lee@acme\.dev · handing off, back /);
  const failed = { at: T0, error: "not logged in", account: WORK };
  assert.match(m.statusText({ cache: failed, state: handoff, now: T0, show: { ...on, usage: false } }), /^lee@acme\.dev · handing off, back /, "with no reading too");
  assert.match(m.statusText({ cache: failed, state: handoff, now: T0 }), /^lee@acme\.dev · usage: not logged in · handing off, back /);
});

test("only the three parts are parts, and a status line is found however its path is quoted", () => {
  for (const p of ["model", "email", "usage"]) assert.ok(m.isPart(p), p);
  for (const p of ["constructor", "toString", "__proto__", "hasOwnProperty"]) assert.ok(!m.isPart(p), p);
  assert.throws(() => m.setShow("constructor", "off"), /no part constructor/);

  const dir = mkdtempSync(path.join(tmpdir(), "switches-sl-"));
  const put = (file, command) => writeFileSync(path.join(dir, file), JSON.stringify({ statusLine: { type: "command", command } }));
  assert.equal(m.statusLineSet(dir), false, "no settings at all");
  put("settings.json", "node '/home/lee/.claude/skills/usage-handoff/scripts/usage.mjs' statusline");
  assert.equal(m.statusLineSet(dir), true, "single quotes");
  put("settings.json", "node /home/lee/.claude/skills/usage-handoff/scripts/usage.mjs statusline --no-link");
  assert.equal(m.statusLineSet(dir), true, "no quotes");
  put("settings.local.json", "my-own-status-line.sh");
  assert.equal(m.statusLineSet(dir), false, "settings.local.json wins");
  put("settings.local.json", `node "C:/x/usage-handoff/scripts/usage.mjs" statusline`);
  writeFileSync(path.join(dir, "settings.json"), "{}");
  assert.equal(m.statusLineSet(dir), true, "set in settings.local.json only");
});

test("usage.mjs show flips, sets and lists the parts, stored in config.json", () => {
  const first = usage(["show"]);
  assert.equal(first.code, 0);
  assert.equal(first.out, "show-model: on (the session's model)\nshow-email: on (the logged-in account)\nshow-usage: on (each window's usage and reset)");
  const { home, cfg } = first;
  const off = usage(["show", "email", "toggle"], { home, cfg });
  assert.equal(off.code, 0, off.out);
  assert.match(off.out, /^show-email: off \(the logged-in account\)$/m);
  assert.match(off.out, /The status line isn't set up yet: \/usage-handoff statusline shows how\./);
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")).show, { email: false });
  assert.match(usage(["show", "email", "toggle"], { home, cfg }).out, /^show-email: on/);
  assert.match(usage(["show", "email", "off"], { home, cfg }).out, /^show-email: off/);
  assert.match(usage(["show", "email", "off"], { home, cfg }).out, /^show-email: off/, "off twice stays off");
  assert.match(usage(["show", "email"], { home, cfg }).out, /^show-email: off/, "no value: just the setting");

  usage(["hook", "off"], { home, cfg });
  const both = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"));
  assert.deepEqual([both.hook, both.show.email], ["off", false], "the hook switch and the parts share the file");

  writeFileSync(path.join(cfg, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: `node "${SCRIPT.replaceAll("\\", "/")}" statusline` } }));
  usage(["show", "model", "off"], { home, cfg });
  const last = usage(["show", "usage", "off"], { home, cfg });
  assert.ok(!last.out.includes("isn't set up"), last.out);
  assert.match(last.out, /Every part is off, so the status line is empty\./);

  for (const bad of [["show", "avatar", "on"], ["show", "email", "maybe"]]) {
    const r = usage(bad, { home, cfg });
    assert.equal(r.code, 1, bad.join(" "));
    assert.match(r.out, /^show/);
  }
});

test("/show-model, /show-email and /show-usage run usage-handoff's script next to them, only when typed", () => {
  for (const part of ["model", "email", "usage"]) {
    const name = `show-${part}`;
    const text = readFileSync(skillFile(name, "SKILL.md"), "utf8");
    assert.match(text, /^disable-model-invocation: true$/m, name);
    assert.match(text, /^argument-hint: "\[on \| off\]"$/m, name);
    assert.ok(text.includes(`node "USAGE" show ${part} <value>`), name);
    assert.ok(text.includes("`toggle` when there is none"), name);
    assert.ok(text.includes("<SKILL_DIR>/../usage-handoff/scripts/usage.mjs"), name);
    assert.ok(existsSync(path.join(skillDir(name), "..", "usage-handoff", "scripts", "usage.mjs")), `${name}: the sibling script is missing`);
  }
});
