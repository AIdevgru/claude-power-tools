#!/usr/bin/env node
// Installs claude-power-tools skills into a Claude Code config dir (default ~/.claude) and
// merges the hooks they need into its settings.json. Use this OR the plugins, not both: the
// plugins register the same hooks themselves.
//
//   node scripts/install.mjs [--target DIR] [--with ui,projects,graphify] [--all] [--skills a,b]
//                            [--link] [--force] [--no-hooks] [--dry-run]
//
//   --target DIR    config dir (default: $CLAUDE_CONFIG_DIR or ~/.claude)
//   (default)       the core skills: everything in the power-tools plugin
//   --with a,b      also install these groups (ui, projects, graphify) or single skills
//   --all           core + ui + projects (graphify stays opt-in: add --with graphify)
//   --skills a,b    install only these skills
//   --source DIR    install from another copy of this repo (default: this repo)
//   --link          symlink each skill folder (a junction on Windows) instead of copying,
//                   so `git pull` here updates the installed skills
//   --force         replace skills that already exist; the old copies move to
//                   <target>/backups/claude-power-tools/<UTC>/, outside skills/ so they don't load
//   --no-hooks      don't touch settings.json (no hooks, no setting defaults)
//   --no-remote-control
//                   store remoteControlAtStartup: false instead of the default true
//   --dry-run       print what would change, change nothing
//
// Where each skill lives (plugins/<plugin>/skills/<name>, extras/<name>) comes from layout.mjs.
// A skill's subagents (plugins/<plugin>/agents/<skill>-*.md, for example Impeccable's) are copied
// into <target>/agents with ${CLAUDE_PLUGIN_ROOT} pointed at <target>. graphify is opt-in (its
// description claims any codebase question, so it competes with ordinary questions) and also
// needs the `graphifyy` Python package; the installer only checks for it and prints how to get it.
// What was installed, from where and in which mode is recorded in <target>/claude-power-tools.json.
//
// Linked installs from before the plugin split point at <clone>/skills/<name>, which no longer
// exists. Every --link run re-links each skill the manifest records (and each selected one) whose
// link is broken or points elsewhere in this clone, and reports it. A copy run never links: it
// replaces a selected stale link with a copy (backed up) and names the recorded ones it left.
// The manifest also records the groups asked for by name, which /update uses for new skills.
//
// Claude Code settings the collection turns on by default (SETTING_DEFAULTS) come with the core
// group (a plain run, --all, or /update of an install that recorded core). They are written to
// settings.json only when it doesn't have them yet, so a value the owner set in /config or by hand
// always stays. Its --no-<flag> writes the off value, which later runs and /update then keep.
//
// A recorded skill that a release retired (RETIRED in layout.mjs) is taken out on every run: its
// link is removed, a copied folder moves to the backup folder, and it leaves the manifest. An
// entry of that name the manifest doesn't record is someone else's and is left alone.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GROUPS, PLUGINS, pluginDir, pluginHooks, REPO, RETIRED, skillMap, skillsInGroups, version } from "./layout.mjs";
import { graphifyDrift } from "../plugins/power-tools/skills/update/scripts/doctor.mjs";

const PLUGIN_ROOT = "${CLAUDE_PLUGIN_ROOT}";
// What a plain install gets, and what --all adds up to. Extras (graphify) are never implied.
export const DEFAULT_GROUPS = ["core"];
export const ALL_GROUPS = Object.values(PLUGINS).map((p) => p.group);
export const MANIFEST = "claude-power-tools.json";

// Claude Code settings an install turns on unless settings.json already has them. `flag` names the
// --no-<flag> option that stores `off` instead; `what` is how the install log describes it.
export const SETTING_DEFAULTS = [
  { key: "remoteControlAtStartup", on: true, off: false, flag: "remote-control", what: "Remote Control in every new session; /config's \"Enable Remote Control for all sessions\" changes it" },
];

export const availableSkills = (repo = REPO) => Object.keys(skillMap(repo)).sort();

// Subagent files that ship with the selected skills: plugins/<plugin>/agents/<skill>-*.md.
// Returns file names; agentSource() finds the file.
export function agentsFor(selected, repo = REPO) {
  return agentFiles(repo).filter(({ file }) => selected.some((s) => file.startsWith(`${s}-`))).map((a) => a.file).sort();
}

function agentFiles(repo) {
  return Object.keys(PLUGINS).flatMap((plugin) => {
    const dir = path.join(pluginDir(plugin, repo), "agents");
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((file) => ({ file, src: path.join(dir, file) })) : [];
  });
}

const agentSource = (file, repo) => agentFiles(repo).find((a) => a.file === file).src;

// Installed graphify CLI version, or null when it is not on PATH.
export function graphifyCliVersion() {
  const r = spawnSync("graphify", ["--version"], { encoding: "utf8", timeout: 20_000 });
  if (r.status !== 0) return null;
  const m = /(\d+\.\d+\.\d+)/.exec(`${r.stdout} ${r.stderr}`);
  return m ? m[1] : null;
}

// One line of advice when the graphify skill's Python package is missing, or older or newer than
// the skill. The version wording is the doctor's, so /update and the installer say the same thing.
export function graphifyHint(cli, skill) {
  if (!cli) return "graphify needs its Python CLI: uv tool install graphifyy  (or: pipx install graphifyy)";
  return graphifyDrift(cli, skill);
}

const list = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);

export function parseArgs(argv) {
  const opts = { target: process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), skills: null, with: [], all: false, source: REPO, link: false, force: false, hooks: true, off: [], dryRun: false };
  const offFlags = new Map(SETTING_DEFAULTS.map((d) => [`--no-${d.flag}`, d.flag]));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (offFlags.has(a)) {
      opts.off.push(offFlags.get(a));
      continue;
    }
    if (a === "--target") opts.target = argv[++i];
    else if (a === "--skills") opts.skills = list(argv[++i]);
    else if (a === "--with") opts.with.push(...list(argv[++i]));
    else if (a === "--all") opts.all = true;
    else if (a === "--source") opts.source = path.resolve(argv[++i]);
    else if (a === "--link") opts.link = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--no-hooks") opts.hooks = false;
    else if (a === "--dry-run") opts.dryRun = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (!opts.target) throw new Error("--target needs a directory");
  return opts;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
const slash = (p) => p.replace(/\\/g, "/");

// Every plugin's hooks.json, rewritten for a plain ~/.claude/skills install and limited to the
// hooks whose script belongs to a selected skill.
export function hooksFor(selected, skillsDir, repo = REPO) {
  const out = {};
  for (const plugin of Object.keys(PLUGINS)) {
    for (const [event, groups] of Object.entries(pluginHooks(plugin, repo).hooks)) {
      for (const group of groups) {
        const hooks = group.hooks.filter((h) => {
          const m = /\/skills\/([^/]+)\//.exec(h.command ?? "");
          return m && selected.includes(m[1]);
        }).map((h) => ({ ...h, command: h.command.replaceAll(`${PLUGIN_ROOT}/skills`, slash(skillsDir)) }));
        if (hooks.length) (out[event] ??= []).push({ ...group, hooks });
      }
    }
  }
  return out;
}

// Adds each hook group unless a hook with the same command already exists for that event.
export function mergeHooks(settings, hooks) {
  const merged = structuredClone(settings);
  merged.hooks ??= {};
  const added = [];
  for (const [event, groups] of Object.entries(hooks)) {
    const existing = merged.hooks[event] ??= [];
    const commands = new Set(existing.flatMap((g) => (g.hooks ?? []).map((h) => h.command)));
    for (const group of groups) {
      const fresh = group.hooks.filter((h) => !commands.has(h.command));
      if (!fresh.length) continue;
      existing.push({ ...group, hooks: fresh });
      added.push(`${event}${group.matcher ? `[${group.matcher}]` : ""}: ${fresh.map((h) => h.command).join("; ")}`);
    }
  }
  return { settings: merged, added };
}

// Fills in each SETTING_DEFAULTS key settings.json doesn't have. A flag in `off` writes its off
// value even over a value already there, since the owner just asked for it. With defaults false
// (an install without the core group) only those flags are written.
export function applySettingDefaults(settings, off = [], { defaults = true } = {}) {
  const merged = structuredClone(settings);
  const set = [];
  for (const d of SETTING_DEFAULTS) {
    if (!defaults && !off.includes(d.flag)) continue;
    const value = off.includes(d.flag) ? d.off : d.on;
    if (Object.hasOwn(merged, d.key) && (merged[d.key] === value || !off.includes(d.flag))) continue;
    merged[d.key] = value;
    set.push({ key: d.key, value, what: d.what, flag: d.flag });
  }
  return { settings: merged, set };
}

// The groups a run asks for by name: the core group (or every plugin group with --all) plus each
// --with group. --skills and single --with skills name no group.
export function selectedGroups(opts) {
  if (opts.skills) return [];
  return [...new Set([...(opts.all ? ALL_GROUPS : DEFAULT_GROUPS), ...(opts.with ?? []).filter((w) => GROUPS.includes(w))])];
}

// The groups of the given skills, from a skillMap; for manifests written before groups were recorded.
export const groupsOf = (names, map) => [...new Set(names.map((n) => map[n]?.group).filter(Boolean))].sort();

// The skills an install covers: --skills as given; otherwise the core group (or every plugin
// group with --all), plus each --with group or skill. `map` is the source's skillMap.
export function selectSkills(opts, map = skillMap(REPO)) {
  const all = Object.keys(map).sort();
  const selected = opts.skills ?? [...skillsInGroups(selectedGroups(opts), undefined, map), ...(opts.with ?? []).filter((w) => !GROUPS.includes(w))];
  const unknown = selected.filter((s) => !all.includes(s));
  if (unknown.length) throw new Error(`unknown skill(s) or group(s): ${unknown.join(", ")}. Groups: ${GROUPS.join(", ")}. Skills: ${all.join(", ")}`);
  return [...new Set(selected)].sort();
}

// The manifest an earlier install wrote, or null.
export function readManifest(target) {
  try {
    return JSON.parse(readFileSync(path.join(target, MANIFEST), "utf8"));
  } catch {
    return null;
  }
}

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});

function sourceInfo(repo) {
  const plugin = readJson(path.join(pluginDir("power-tools", repo), ".claude-plugin", "plugin.json"));
  const r = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 10_000 });
  return { version: version(repo), repository: plugin.repository, commit: r.status === 0 ? r.stdout.trim() : null };
}

// Where a symlink or junction points (absolute), or null when p is not a link.
export function linkTarget(p) {
  try {
    if (!lstatSync(p).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return path.resolve(path.dirname(p), readlinkSync(p).replace(/^\\\\\?\\/, ""));
}

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const inside = (child, parent) => {
  const rel = path.relative(real(parent), real(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

// A link that should point at src but doesn't: it is broken (no SKILL.md behind it), or it points
// elsewhere in this clone (the pre-split skills/<name>). A link to another valid copy is left alone.
export function staleLink(dest, src, repo) {
  const cur = linkTarget(dest);
  if (!cur || real(cur) === real(src)) return false;
  return !existsSync(path.join(cur, "SKILL.md")) || inside(cur, repo);
}

export function install(opts, log = console.log) {
  const repo = opts.source ?? REPO;
  // One scan of the source's folders, shared by everything below.
  const skills = skillMap(repo);
  const selected = selectSkills(opts, skills);
  const before = readManifest(opts.target);

  const skillsDir = path.join(opts.target, "skills");
  const backupDir = path.join(opts.target, "backups", "claude-power-tools", stamp());
  const report = { installed: [], relinked: [], retired: [], replacedLinks: [], staleLinks: [], skipped: [], backedUp: [], agents: [], agentsSkipped: [], hooksAdded: [], settingsSet: [], settingsBackup: null, notes: [], manifest: null };
  if (!opts.dryRun) mkdirSync(skillsDir, { recursive: true });
  const link = (src, dest) => symlinkSync(src, dest, process.platform === "win32" ? "junction" : "dir");
  const isStale = (name) => staleLink(path.join(skillsDir, name), path.join(repo, skills[name].dir), repo);

  // Each recorded or selected skill whose link went stale (the plugin split moved them). Only a
  // --link run re-links: a copy run's source may be a temporary download (a copy-mode /update)
  // that is deleted afterwards. A copy run replaces a selected stale link with a copy below and
  // names the recorded ones it leaves alone.
  const recorded = before?.skills ?? [];
  for (const name of [...new Set([...recorded, ...selected])].filter((n) => skills[n]).sort()) {
    if (!isStale(name)) continue;
    if (!opts.link) {
      if (!selected.includes(name)) report.staleLinks.push(name);
      continue;
    }
    const dest = path.join(skillsDir, name);
    if (!opts.dryRun) {
      unlinkSync(dest);
      link(path.join(repo, skills[name].dir), dest);
    }
    report.relinked.push(name);
  }

  // Recorded skills a release retired. Only recorded ones: an entry the manifest doesn't list was
  // not installed by us. A link (symlink or junction) is removed, which leaves what it points at;
  // a real folder is a copy install and is backed up, never deleted.
  for (const name of recorded.filter((n) => RETIRED[n] && !skills[n])) {
    const dest = path.join(skillsDir, name);
    let entry = null;
    try {
      entry = lstatSync(dest);
    } catch {
      // already gone; just drop it from the manifest
    }
    if (entry?.isSymbolicLink()) {
      if (!opts.dryRun) unlinkSync(dest);
    } else if (entry) {
      const bak = path.join(backupDir, "skills", name);
      if (!opts.dryRun) {
        mkdirSync(path.dirname(bak), { recursive: true });
        renameSync(dest, bak);
      }
      report.backedUp.push(slash(bak));
    }
    report.retired.push(name);
  }

  for (const name of selected) {
    if (report.relinked.includes(name)) continue;
    const src = path.join(repo, skills[name].dir);
    const dest = path.join(skillsDir, name);
    let exists = false;
    try {
      lstatSync(dest);
      exists = true;
    } catch {
      // not installed yet
    }
    // In a copy run a stale link is replaced (and backed up) even without --force: keeping it
    // would leave a broken or outdated link under a manifest that says copy.
    const staleInCopy = exists && !opts.link && isStale(name);
    if (staleInCopy) report.replacedLinks.push(name);
    if (exists && !opts.force && !staleInCopy) {
      report.skipped.push(name);
      continue;
    }
    if (exists) {
      const bak = path.join(backupDir, "skills", name);
      if (!opts.dryRun) {
        mkdirSync(path.dirname(bak), { recursive: true });
        renameSync(dest, bak);
      }
      report.backedUp.push(slash(bak));
    }
    if (!opts.dryRun) {
      if (opts.link) link(src, dest);
      else cpSync(src, dest, { recursive: true, filter: (p) => !/[\\/](__pycache__|node_modules)([\\/]|$)/.test(p) });
    }
    report.installed.push(name);
  }

  // Agents follow their skill: a skipped (already installed) skill keeps its own agents. They
  // are always copied, never linked, because ${CLAUDE_PLUGIN_ROOT} is rewritten to the target.
  const agentsDir = path.join(opts.target, "agents");
  for (const file of agentsFor(report.installed, repo)) {
    const dest = path.join(agentsDir, file);
    if (existsSync(dest) && !opts.force) {
      report.agentsSkipped.push(file);
      continue;
    }
    if (existsSync(dest)) {
      const bak = path.join(backupDir, "agents", file);
      if (!opts.dryRun) {
        mkdirSync(path.dirname(bak), { recursive: true });
        renameSync(dest, bak);
      }
      report.backedUp.push(slash(bak));
    }
    if (!opts.dryRun) {
      mkdirSync(agentsDir, { recursive: true });
      const text = readFileSync(agentSource(file, repo), "utf8");
      writeFileSync(dest, text.replaceAll(PLUGIN_ROOT, slash(opts.target)));
    }
    report.agents.push(file);
  }

  if (selected.includes("graphify")) {
    const marker = path.join(repo, skills.graphify.dir, ".graphify_version");
    const skillVersion = existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;
    const hint = graphifyHint((opts.graphifyVersion ?? graphifyCliVersion)(), skillVersion);
    if (hint) report.notes.push(hint);
  }

  if (opts.hooks) {
    const settingsPath = path.join(opts.target, "settings.json");
    let settings = {};
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, "utf8");
      try {
        settings = raw.trim() ? JSON.parse(raw) : {};
      } catch (e) {
        throw new Error(`${settingsPath} is not valid JSON (${e.message}); fix it, or rerun with --no-hooks`);
      }
    }
    const { settings: hooked, added } = mergeHooks(settings, hooksFor(selected, skillsDir, repo));
    // The defaults come with the core group, as its plugin's enhancements: a plain run, --all, or
    // /update of an install that recorded core. `--skills pr-dashboard` alone gets only the skill.
    const core = [...selectedGroups(opts), ...(before?.groups ?? groupsOf(recorded, skills))].includes("core");
    const { settings: merged, set } = applySettingDefaults(hooked, opts.off ?? [], { defaults: core });
    report.hooksAdded = added;
    report.settingsSet = set;
    if ((added.length || set.length) && !opts.dryRun) {
      if (existsSync(settingsPath)) {
        report.settingsBackup = slash(`${settingsPath}.bak-${stamp()}`);
        cpSync(settingsPath, report.settingsBackup);
      }
      writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n");
    }
  }

  if (report.installed.length || report.relinked.length || report.retired.length) {
    // Re-linking happens only in a --link run, so the run's mode is what it left behind.
    // `groups` are the groups asked for by name, so far: /update offers new skills only in these.
    // A manifest from before groups were recorded gets them from its skills.
    report.manifest = {
      name: "claude-power-tools",
      ...sourceInfo(repo),
      mode: opts.link ? "link" : "copy",
      source: slash(repo),
      skills: [...new Set([...recorded, ...report.installed, ...report.relinked])].filter((n) => !report.retired.includes(n)).sort(),
      groups: [...new Set([...(before?.groups ?? groupsOf(recorded, skills)), ...selectedGroups(opts)])].sort(),
      updated: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    if (!opts.dryRun) writeFileSync(path.join(opts.target, MANIFEST), JSON.stringify(report.manifest, null, 2) + "\n");
  }

  const pre = opts.dryRun ? "[dry run] would " : "";
  log(`${pre}install ${report.installed.length} skill(s) into ${slash(skillsDir)}${opts.link ? " (linked)" : ""}: ${report.installed.join(", ") || "none"}`);
  if (report.relinked.length) log(`${pre}re-link ${report.relinked.length} skill(s) to their new folders in ${slash(repo)}: ${report.relinked.join(", ")}`);
  if (report.replacedLinks.length) log(`${pre}replace ${report.replacedLinks.length} stale link(s) with copies: ${report.replacedLinks.join(", ")}`);
  if (report.staleLinks.length) log(`left alone: ${report.staleLinks.length} recorded skill(s) whose link is stale (${report.staleLinks.join(", ")}); run the installer with --link in your clone to re-link them`);
  for (const n of report.retired) log(`${pre}remove retired skill ${n} (use /${RETIRED[n]})`);
  if (report.skipped.length) log(`skipped (already installed; --force replaces them): ${report.skipped.join(", ")}`);
  if (report.agents.length) log(`${pre}install ${report.agents.length} agent(s) into ${slash(agentsDir)}: ${report.agents.join(", ")}`);
  if (report.agentsSkipped.length) log(`agents skipped (already installed; --force replaces them): ${report.agentsSkipped.join(", ")}`);
  for (const b of report.backedUp) log(`${pre}back up the old copy to ${b}`);
  if (opts.hooks) {
    if (report.hooksAdded.length) {
      log(`${pre}add ${report.hooksAdded.length} hook(s) to ${slash(path.join(opts.target, "settings.json"))}:`);
      for (const h of report.hooksAdded) log(`  ${h}`);
      if (!opts.dryRun) log("Open /hooks once (or restart Claude Code) so running sessions pick the hooks up.");
    } else {
      log("hooks: already present");
    }
    for (const s of report.settingsSet) {
      log(`${pre}set ${s.key}: ${JSON.stringify(s.value)} in settings.json (${s.what}${s.value === SETTING_DEFAULTS.find((d) => d.key === s.key).on ? `; --no-${s.flag} turns it off` : ""})`);
    }
    if (report.settingsBackup) log(`settings backup: ${report.settingsBackup}`);
    else if (!report.hooksAdded.length && !report.settingsSet.length) log("settings.json unchanged");
  }
  if (!opts.skills) {
    const inGroup = Object.fromEntries(GROUPS.map((g) => [g, skillsInGroups([g], repo, skills)]));
    const missing = GROUPS.filter((g) => inGroup[g].some((s) => !selected.includes(s) && !recorded.includes(s)));
    if (missing.length) log(`not installed: ${missing.map((g) => `${g} (${inGroup[g].join(", ")})`).join("; ")}. Add with --with ${missing.join(",")}${missing.some((g) => ALL_GROUPS.includes(g)) ? " or --all" : ""}.`);
  }
  for (const n of report.notes) log(`note: ${n}`);
  return report;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    install(parseArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(`install failed: ${e.message}`);
    process.exit(1);
  }
}
