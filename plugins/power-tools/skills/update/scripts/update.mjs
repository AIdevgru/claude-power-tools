#!/usr/bin/env node
// Updates installed claude-power-tools skills to the latest version on GitHub.
//
//   node update.mjs [--force] [--all] [--ref TAG|BRANCH] [--repo OWNER/NAME] [--target DIR]
//
// Without --force it only reports what would change. How it updates depends on how the skills
// were installed (the installer records this in <target>/claude-power-tools.json):
//   plugin  /plugin installs: runs `claude plugin marketplace update` and `claude plugin update`
//           for each of our plugins installed at user scope or in this project; only a migration
//           from the 0.5 plugin installs power-tools and names the plugins that aren't installed
//   link    installer --link: fast-forwards the linked clone, then re-links every recorded skill
//           (0.6 moved them from skills/ into plugins/*/skills/ and extras/) and links new ones
//   copy    installer copy: downloads the repo (gh repo clone, shallow) into a temp folder and
//           reinstalls the installed skills from it with --force (old copies are backed up)
// --all also installs skills that are new since the last install, in the installer groups the
// install has (the manifest records them); it never adds a group, so graphify stays opt-in.
// --ref picks a tag or branch (default: the latest release, else the default branch).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = "claude-power-tools.json";
const DEFAULT_REPO = "aidevgru/claude-power-tools";
const MARKETPLACE = "aidevgru";
const slash = (p) => p.replace(/\\/g, "/");

// "owner/name" from a GitHub URL or an owner/name string.
export function parseRepo(value) {
  const m = /(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(value ?? "").trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export function readManifest(target) {
  try {
    return JSON.parse(readFileSync(path.join(target, MANIFEST), "utf8"));
  } catch {
    return null;
  }
}

// A plugin install runs from Claude Code's plugin cache (<config>/plugins/cache/...). A linked
// install runs from the clone's real path, which has a plugins/ folder of its own, so match the
// cache, not any plugins/ folder.
export const inPluginCache = (dir) => /[\\/]plugins[\\/](?:cache|marketplaces)[\\/]/.test(dir);

// plugin, link or copy, from where this skill lives and what the manifest says.
export function detectMode(skillDir, manifest) {
  if (inPluginCache(skillDir) || process.env.CLAUDE_PLUGIN_ROOT) return "plugin";
  if (manifest?.mode) return manifest.mode;
  try {
    return lstatSync(skillDir).isSymbolicLink() ? "link" : "copy";
  } catch {
    return "copy";
  }
}

// Which skills to refresh and which are new, given what was installed and what the new version has.
// A skill is new only in a group the install has (groupOf: skill -> installer group of the new
// version), so a core install isn't offered the ui, projects or graphify skills, and --all never
// brings in graphify unless the install already has it.
export function plan(installed, available, { all = false, groups = [], groupOf = {} } = {}) {
  const update = installed.filter((s) => available.includes(s));
  const added = available.filter((s) => !installed.includes(s) && groups.includes(groupOf[s]));
  const removed = installed.filter((s) => !available.includes(s));
  return { update, added, removed, install: all ? [...update, ...added] : update };
}

// The installer groups an install has: what the manifest recorded, else (a manifest from before
// groups were recorded, or none) the groups of the installed skills.
export function installedGroups(manifest, installed, groupOf) {
  if (Array.isArray(manifest?.groups)) return manifest.groups;
  return [...new Set(installed.map((s) => groupOf[s]).filter(Boolean))].sort();
}

// skill -> installer group, from the layout.mjs of a clone or download (0.6 and later). The
// installer that ships with it runs next anyway. A 0.5 clone has no groups, so nothing is new.
export async function skillGroups(repo) {
  const file = path.join(repo, "scripts", "layout.mjs");
  if (!existsSync(file)) return {};
  const { skillMap } = await import(pathToFileURL(file).href);
  return Object.fromEntries(Object.entries(skillMap(repo)).map(([name, s]) => [name, s.group]));
}

async function planFor(manifest, target, repo, opts) {
  const available = skillsIn(repo);
  const groupOf = await skillGroups(repo);
  const installed = manifest?.skills ?? guessInstalled(target, available);
  return plan(installed, available, { all: opts.all, groups: installedGroups(manifest, installed, groupOf), groupOf });
}

// Skills installed in target that this collection ships, for installs older than the manifest.
function guessInstalled(target, available) {
  const dir = path.join(target, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((s) => available.includes(s));
}

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 180_000, windowsHide: true, ...opts });

// The skills a clone or download of the repo ships. This script ships inside a plugin, so it
// can't import its own repo's scripts/layout.mjs; it reads both layouts instead: plugins/*/skills/*
// and extras/* (0.6 and later) and skills/* (0.5 and earlier). Which of them are new for an
// install is up to plan(), using the groups from the clone's own layout.mjs (skillGroups).
export function skillsIn(repo) {
  const dirs = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)) : []);
  const homes = [path.join(repo, "skills"), path.join(repo, "extras"), ...dirs(path.join(repo, "plugins")).map((p) => path.join(p, "skills"))];
  const names = homes.flatMap(dirs).filter((d) => existsSync(path.join(d, "SKILL.md"))).map((d) => path.basename(d));
  return [...new Set(names)].sort();
}

// The collection's version: package.json, else the 0.5 root plugin manifest.
export function versionOf(repo) {
  for (const file of [path.join(repo, "package.json"), path.join(repo, ".claude-plugin", "plugin.json")]) {
    try {
      const v = JSON.parse(readFileSync(file, "utf8")).version;
      if (v) return v;
    } catch {
      // try the next one
    }
  }
  return "unknown";
}

// The clone a linked install points at: the first folder above this skill with scripts/install.mjs.
export function cloneRoot(skillDir) {
  for (let dir = skillDir; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "scripts", "install.mjs"))) return dir;
    if (path.dirname(dir) === dir) return path.resolve(skillDir, "..", "..");
  }
}

function latestRef(repo) {
  const r = run("gh", ["release", "view", "--repo", repo, "--json", "tagName", "--jq", ".tagName"]);
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function report(lines, force) {
  for (const l of lines) console.log(l);
  if (!force) console.log("\nNothing changed. Run /update --force to apply.");
}

// The collection ships as three plugins since 0.6. 0.5 had one, claude-power-tools, which the
// marketplace renames to power-tools: the rename moves the enabled setting, but the old install
// record stays, and `claude plugin update power-tools` says it isn't installed. So an old install
// gets `claude plugin install power-tools` instead. That is the only install /update ever runs.
export const PLUGINS = ["power-tools", "power-tools-ui", "power-tools-projects"];
export const OLD_PLUGIN = "claude-power-tools";

// True when dir is base or inside it (case-insensitive on Windows).
function within(dir, base) {
  const norm = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(norm(base), norm(dir));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Our plugins (and the 0.5 one) that `claude plugin list --json` shows as installed here: rows
// at user scope, or at project or local scope for the project /update runs in (cwd). Rows of other
// projects, and managed ones, are someone else's to update. A row without a scope (an older CLI)
// counts as user scope.
export function listedPlugins(listJson, cwd = process.cwd()) {
  let rows;
  try {
    rows = JSON.parse(listJson);
  } catch {
    return [];
  }
  const here = (r) => typeof r === "string" || !r?.scope || r.scope === "user" || ((r.scope === "project" || r.scope === "local") && !!r.projectPath && within(cwd, r.projectPath));
  const ids = (Array.isArray(rows) ? rows : rows?.plugins ?? []).filter(here).map((r) => (typeof r === "string" ? r : r?.id ?? (r?.name && r?.marketplace ? `${r.name}@${r.marketplace}` : r?.name)) ?? "");
  const names = ids.filter((id) => id.endsWith(`@${MARKETPLACE}`)).map((id) => id.slice(0, -MARKETPLACE.length - 1));
  return [OLD_PLUGIN, ...PLUGINS].filter((p) => names.includes(p));
}

// The commands that bring the listed plugins up to date (after the marketplace update). Nothing
// listed (the list failed) means power-tools, since /update itself runs from it. Only a migration
// from the 0.5 plugin (its record is listed) installs anything: power-tools under its new name, if
// `claude plugin update` can't find it. The hints naming the plugins that aren't installed are for
// that migration too; after it, which plugins to add is the owner's business.
export function pluginSteps(listed) {
  const has = (p) => listed.includes(p);
  const renamed = has(OLD_PLUGIN);
  const steps = [];
  if (has("power-tools") || !listed.length) steps.push(["claude", ["plugin", "update", `power-tools@${MARKETPLACE}`], { installIfMissing: renamed }]);
  else if (renamed) steps.push(["claude", ["plugin", "install", `power-tools@${MARKETPLACE}`]]);
  for (const p of PLUGINS.slice(1)) if (has(p)) steps.push(["claude", ["plugin", "update", `${p}@${MARKETPLACE}`]]);
  const missing = renamed ? PLUGINS.slice(1).filter((p) => !has(p)) : [];
  const hints = missing.length
    ? [`Since 0.6 the skills ship as three plugins. Not installed here: ${missing.join(", ")}. Add with:`, ...missing.map((p) => `  claude plugin install ${p}@${MARKETPLACE}`)]
    : [];
  return { steps, hints };
}

const MARKET_STEP = ["claude", ["plugin", "marketplace", "update", MARKETPLACE]];

function listPlugins() {
  const r = run("claude", ["plugin", "list", "--json"]);
  return r.status === 0 ? listedPlugins(r.stdout) : [];
}

function runStep([c, a, { installIfMissing = false } = {}]) {
  let r = run(c, a);
  // power-tools under its old 0.5 record: the update can't find it, so install it under the new name.
  if (r.status !== 0 && installIfMissing && /not installed/i.test(`${r.stderr}${r.stdout}`)) r = run(c, ["plugin", "install", a[2]]);
  process.stdout.write(r.stdout ?? "");
  if (r.status !== 0) throw new Error(`${c} ${a.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
}

function updatePlugin(force) {
  // Listed before the marketplace update, which is what applies the rename and can drop the old record.
  const before = listPlugins();
  if (!force) {
    const { steps, hints } = pluginSteps(before);
    return report(["Installed as a plugin. /update --force runs:", ...[MARKET_STEP, ...steps].map(([c, a]) => `  ${c} ${a.join(" ")}`), "then restart Claude Code.", ...hints], false);
  }
  runStep(MARKET_STEP);
  const { steps, hints } = pluginSteps([...new Set([...before, ...listPlugins()])]);
  for (const step of steps) runStep(step);
  console.log(["Updated. Restart Claude Code to load the new version.", ...hints].join("\n"));
}

async function updateLink(manifest, target, opts) {
  const clone = manifest?.source ? path.resolve(manifest.source) : cloneRoot(realpathSync(SKILL_DIR));
  if (!existsSync(path.join(clone, ".git"))) throw new Error(`linked install, but ${slash(clone)} is not a git clone`);
  const git = (...a) => run("git", ["-C", clone, ...a]);
  if (git("status", "--porcelain").stdout.trim()) throw new Error(`${slash(clone)} has uncommitted changes; commit or stash them there first`);
  const branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  const upstream = git("rev-parse", "--abbrev-ref", "@{u}");
  if (upstream.status !== 0) throw new Error(`${slash(clone)} is on ${branch}, which has no upstream; check out the default branch there first`);
  if (git("fetch", "--quiet").status !== 0) throw new Error(`git fetch failed in ${slash(clone)}`);
  const log = git("log", "--oneline", "HEAD..@{u}").stdout.trim();
  const ahead = git("rev-list", "--count", "@{u}..HEAD").stdout.trim();
  const before = versionOf(clone);
  const lines = [`Linked install from ${slash(clone)} (${branch}, version ${before}).`];
  if (!log) lines.push(`Already up to date with ${upstream.stdout.trim()}.`);
  else lines.push(`New commits on ${upstream.stdout.trim()}:`, ...log.split("\n").map((l) => `  ${l}`));
  if (ahead !== "0") lines.push(`Note: ${branch} has ${ahead} local commit(s) not on ${upstream.stdout.trim()}; the pull must fast-forward.`);
  if (!opts.force) return report(lines, false);
  if (log && git("pull", "--ff-only", "--quiet").status !== 0) throw new Error(`git pull --ff-only failed in ${slash(clone)}; it has diverged from ${upstream.stdout.trim()}`);
  const p = await planFor(manifest, target, clone, opts);
  installFrom(clone, target, p.install, { link: true });
  lines.push(`Version ${before} → ${versionOf(clone)}.`, ...newSkillLines(p, opts));
  report(lines, true);
}

async function updateCopy(manifest, target, opts) {
  const repo = opts.repo ?? parseRepo(manifest?.repository) ?? DEFAULT_REPO;
  const ref = opts.ref ?? latestRef(repo);
  const tmp = mkdtempSync(path.join(tmpdir(), "cpt-update-"));
  const src = path.join(tmp, "src");
  try {
    const args = ["repo", "clone", repo, src, "--", "--depth", "1", ...(ref ? ["--branch", ref] : [])];
    let r = run("gh", args);
    if (r.status !== 0) r = run("git", ["clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), `https://github.com/${repo}.git`, src]);
    if (r.status !== 0) throw new Error(`could not download ${repo}${ref ? `@${ref}` : ""}: ${(r.stderr || "").trim()}`);
    const commit = run("git", ["-C", src, "rev-parse", "HEAD"]).stdout.trim();
    const p = await planFor(manifest, target, src, opts);
    const from = manifest ? `${manifest.version}${manifest.commit ? ` (${manifest.commit.slice(0, 7)})` : ""}` : "unknown (installed before the manifest existed)";
    const lines = [`Copied install in ${slash(target)}.`, `Installed: ${from}`, `Latest:    ${versionOf(src)} (${commit.slice(0, 7)}) from ${repo}${ref ? `@${ref}` : ""}`];
    if (manifest?.commit === commit) lines.push("Already up to date.");
    else if (manifest?.commit) {
      const cmp = run("gh", ["api", `repos/${repo}/compare/${manifest.commit}...${commit}`, "--jq", ".commits[].commit.message | split(\"\\n\")[0]"]);
      if (cmp.status === 0 && cmp.stdout.trim()) lines.push("Changes:", ...cmp.stdout.trim().split("\n").map((l) => `  ${l}`));
    }
    lines.push(`Would update: ${p.update.join(", ") || "nothing"}`, ...newSkillLines(p, opts));
    if (!opts.force || manifest?.commit === commit) return report(lines, opts.force);
    installFrom(src, target, p.install, { link: false, force: true });
    lines.push("Updated. Old copies are in <target>/backups/claude-power-tools/. Open /hooks once (or restart) so running sessions load new hooks.");
    report(lines, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function newSkillLines(p, opts) {
  const out = [];
  if (p.added.length) out.push(opts.all ? `Also installing new skills: ${p.added.join(", ")}` : `New skills available (add with --all): ${p.added.join(", ")}`);
  if (p.removed.length) out.push(`No longer shipped (left in place): ${p.removed.join(", ")}`);
  return out;
}

// Runs the installer that ships with the downloaded or linked version.
function installFrom(repo, target, skills, { link, force = false }) {
  if (!skills.length) return;
  const args = [path.join(repo, "scripts", "install.mjs"), "--target", target, "--skills", skills.join(",")];
  if (link) args.push("--link");
  if (force) args.push("--force");
  execFileSync(process.execPath, args, { stdio: "inherit" });
}

export function parseArgs(argv) {
  const opts = { force: false, all: false, ref: null, repo: null, target: process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") opts.force = true;
    else if (a === "--all") opts.all = true;
    else if (a === "--ref") opts.ref = argv[++i];
    else if (a === "--repo") opts.repo = parseRepo(argv[++i]);
    else if (a === "--target") opts.target = path.resolve(argv[++i]);
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const manifest = readManifest(opts.target);
    const mode = detectMode(SKILL_DIR, manifest);
    if (mode === "plugin") updatePlugin(opts.force);
    else if (mode === "link") await updateLink(manifest, opts.target, opts);
    else await updateCopy(manifest, opts.target, opts);
  } catch (e) {
    console.error(`update failed: ${e.message}`);
    process.exit(1);
  }
}
