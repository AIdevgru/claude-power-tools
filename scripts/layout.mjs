// Where every skill lives in this repo. The single source of truth for the scripts and tests:
// nothing else hard-codes `plugins/<plugin>/skills/<name>` or `extras/<name>`.
//
//   plugins/<plugin>/                one Claude Code plugin per folder, listed in
//     .claude-plugin/plugin.json     .claude-plugin/marketplace.json
//     skills/<name>/SKILL.md
//     agents/<skill>-*.md            subagents that ship with a skill (power-tools-ui only)
//     hooks/hooks.json               paths are ${CLAUDE_PLUGIN_ROOT}/skills/<name>/...
//   extras/<name>/SKILL.md           installer-only skills that no plugin lists (graphify)
//
// A plugin is copied into the plugin cache on its own, so a file in one plugin never reaches
// into another with `../`; skills in different plugins call each other by Skill name only.
// Skill membership comes from the folders; this file names the plugins, their installer groups
// and the extras. `root` defaults to this repo, so the installer can read another copy of it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Plugin name -> installer group. `core` is what a plain install gets.
export const PLUGINS = {
  "power-tools": { group: "core", dir: "plugins/power-tools" },
  "power-tools-ui": { group: "ui", dir: "plugins/power-tools-ui" },
  "power-tools-projects": { group: "projects", dir: "plugins/power-tools-projects" },
};

// Installer-only skills, each its own group. Opt-in: not part of the default install or --all.
export const EXTRAS = { graphify: "extras/graphify" };

// Skills a release removed, and the command that replaces each. An install or /update run takes
// a recorded one out of <target>/skills (a link is removed, a copy is backed up) and out of the
// manifest. Keep an entry for a few releases, so installs that skip versions still get it.
export const RETIRED = { "ship-plan": "implement-to-pr --review-plan --merge" };

// The installer's --with groups, in install order. --all takes every plugin group, not extras.
export const GROUPS = [...Object.values(PLUGINS).map((p) => p.group), ...Object.keys(EXTRAS)];

const isSkill = (dir) => existsSync(path.join(dir, "SKILL.md"));
const subdirs = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);

// The skills one plugin ships, sorted.
export function pluginSkills(plugin, root = REPO) {
  const dir = path.join(root, PLUGINS[plugin].dir, "skills");
  return subdirs(dir).filter((n) => isSkill(path.join(dir, n))).sort();
}

// name -> { dir (relative, forward slashes), plugin (null for extras), group }.
export function skillMap(root = REPO) {
  const out = {};
  for (const [plugin, { group, dir }] of Object.entries(PLUGINS)) {
    for (const name of pluginSkills(plugin, root)) {
      if (out[name]) throw new Error(`skill ${name} is in both ${out[name].plugin} and ${plugin}`);
      out[name] = { dir: `${dir}/skills/${name}`, plugin, group };
    }
  }
  for (const [name, dir] of Object.entries(EXTRAS)) {
    if (!isSkill(path.join(root, dir))) continue;
    if (out[name]) throw new Error(`skill ${name} is in both ${out[name].plugin} and ${dir}`);
    out[name] = { dir, plugin: null, group: name };
  }
  return out;
}

// Every skill name, sorted.
export const skillNames = (root = REPO) => Object.keys(skillMap(root)).sort();

// Absolute path of every skill folder, sorted by skill name.
export const skillDirs = (root = REPO) => skillNames(root).map((n) => skillDir(n, root));

// Absolute path of one skill's folder; throws for an unknown skill.
export function skillDir(name, root = REPO) {
  const s = skillMap(root)[name];
  if (!s) throw new Error(`unknown skill ${name}`);
  return path.join(root, s.dir);
}

// Absolute path of a file inside a skill, e.g. skillFile("git-guard", "scripts", "git-guard.mjs").
export const skillFile = (name, ...rel) => path.join(skillDir(name), ...rel);

// Imports a skill's script module, for tests: await skillModule("git-guard", "scripts/git-guard.mjs").
export const skillModule = (name, rel) => import(pathToFileURL(skillFile(name, rel)).href);

// The plugin that ships a skill, or null for an extra (graphify) or an unknown name.
export const pluginOf = (name, root = REPO) => skillMap(root)[name]?.plugin ?? null;

// The skills in the given installer groups (core, ui, projects, graphify). Pass a skillMap you
// already have as `map` to skip rescanning the folders.
export function skillsInGroups(groups, root = REPO, map = skillMap(root)) {
  const unknown = groups.filter((g) => !GROUPS.includes(g));
  if (unknown.length) throw new Error(`unknown group(s): ${unknown.join(", ")}. Groups: ${GROUPS.join(", ")}`);
  return Object.entries(map).filter(([, s]) => groups.includes(s.group)).map(([n]) => n).sort();
}

// Absolute path of a plugin's folder.
export const pluginDir = (plugin, root = REPO) => path.join(root, PLUGINS[plugin].dir);

// A plugin's hooks.json ({ hooks }), or { hooks: {} } when it has none.
export function pluginHooks(plugin, root = REPO) {
  const file = path.join(pluginDir(plugin, root), "hooks", "hooks.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { hooks: {} };
}

// The collection's version: package.json at the repo root.
export const version = (root = REPO) => JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
