#!/usr/bin/env node
// Remembers the folders the owner keeps projects in ("roots") and the projects /new-project made
// or was pointed at, with how far each one got through the /new-project workflow.
//
//   node projects.mjs roots                         list the roots (* marks the default)
//   node projects.mjs add-root <dir> [--default] [--create]
//   node projects.mjs remove-root <dir>
//   node projects.mjs default-root <dir>
//   node projects.mjs list [--json]                 registered projects with their stage
//   node projects.mjs add <dir> [--name N]          register an existing project
//   node projects.mjs get <name|dir> [--json]
//   node projects.mjs set <name|dir> key=value ...  e.g. stage=vision github=me/app url.app=https://...
//   node projects.mjs remove <name|dir>             forget it (never deletes files)
//   node projects.mjs scan                          git repos under the roots that aren't registered
//   node projects.mjs --hook                        SessionStart: one line when the session starts
//                                                   inside a project with /new-project work left
//
// The registry is <POWER_TOOLS_HOME>/projects.json (default ~/.claude/power-tools). Times are UTC.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The /new-project stages in order, each with the step that comes next.
export const STAGES = [
  ["created", "connect GitHub (or stay local) and pick the app type"],
  ["scaffolded", "write VISION.md"],
  ["vision", "generate the implementation docs"],
  ["docs", "confirm the summary and plan"],
  ["plan-approved", "run /ux-mockup on the whole vision"],
  ["mockup", "implement with /implement-to-pr"],
  ["implementing", "finish /implement-to-pr, then run and review the app"],
  ["app-ready", "/deploy the splash page and the app"],
  ["deployed", null],
];
const STAGE_NAMES = STAGES.map(([s]) => s);

export const home = (env = process.env) => env.POWER_TOOLS_HOME || path.join(homedir(), ".claude", "power-tools");
const regPath = (h) => path.join(h, "projects.json");
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const norm = (p) => path.resolve(p);
const same = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase();
const slash = (p) => p.replace(/\\/g, "/");

export function load(h = home()) {
  try {
    const reg = JSON.parse(readFileSync(regPath(h), "utf8"));
    return { version: 1, roots: [], projects: [], ...reg };
  } catch {
    return { version: 1, roots: [], projects: [] };
  }
}

export function save(reg, h = home()) {
  mkdirSync(h, { recursive: true });
  const tmp = `${regPath(h)}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n");
  renameSync(tmp, regPath(h));
}

export function addRoot(reg, dir, { makeDefault = false, create = false } = {}) {
  const p = norm(dir);
  if (!existsSync(p)) {
    if (!create) throw new Error(`${slash(p)} does not exist (pass --create to make it)`);
    mkdirSync(p, { recursive: true });
  }
  if (!statSync(p).isDirectory()) throw new Error(`${slash(p)} is not a folder`);
  let root = reg.roots.find((r) => same(r.path, p));
  if (!root) reg.roots.push((root = { path: p, added: now(), default: false }));
  if (makeDefault || reg.roots.length === 1) for (const r of reg.roots) r.default = r === root;
  return root;
}

export function removeRoot(reg, dir) {
  const before = reg.roots.length;
  reg.roots = reg.roots.filter((r) => !same(r.path, dir));
  if (reg.roots.length === before) throw new Error(`${slash(norm(dir))} is not a remembered root`);
  if (reg.roots.length && !reg.roots.some((r) => r.default)) reg.roots[0].default = true;
}

export function find(reg, key) {
  return reg.projects.find((p) => p.name === key) ?? reg.projects.find((p) => same(p.path, key));
}

export function addProject(reg, dir, { name } = {}) {
  const p = norm(dir);
  let proj = reg.projects.find((x) => same(x.path, p));
  if (!proj) {
    proj = { name: name || path.basename(p), path: p, created: now(), updated: now(), stage: "created" };
    if (reg.projects.some((x) => x.name === proj.name)) proj.name = `${proj.name}-${reg.projects.length + 1}`;
    reg.projects.push(proj);
  }
  return proj;
}

// key=value pairs; dotted keys nest (url.app=...). "stage" must be a known stage.
export function setFields(proj, pairs) {
  for (const pair of pairs) {
    const i = pair.indexOf("=");
    if (i < 1) throw new Error(`expected key=value, got ${pair}`);
    const key = pair.slice(0, i);
    const value = pair.slice(i + 1);
    if (key === "stage" && !STAGE_NAMES.includes(value)) throw new Error(`unknown stage ${value}; stages: ${STAGE_NAMES.join(", ")}`);
    if (["name", "path", "created"].includes(key)) throw new Error(`${key} can't be changed with set`);
    const parts = key.split(".");
    let obj = proj;
    for (const part of parts.slice(0, -1)) obj = obj[part] = typeof obj[part] === "object" && obj[part] ? obj[part] : {};
    obj[parts.at(-1)] = value === "" ? undefined : value;
  }
  proj.updated = now();
  return proj;
}

export const nextStep = (stage) => STAGES.find(([s]) => s === stage)?.[1] ?? null;

// Git repos directly under each root that aren't registered.
export function scan(reg) {
  const out = [];
  for (const r of reg.roots) {
    let entries = [];
    try {
      entries = readdirSync(r.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(r.path, e.name);
      if (e.isDirectory() && existsSync(path.join(p, ".git")) && !reg.projects.some((x) => same(x.path, p))) out.push(p);
    }
  }
  return out.sort();
}

// The registered project that contains dir, deepest first.
export function projectAt(reg, dir) {
  const d = norm(dir).toLowerCase();
  return reg.projects
    .filter((p) => d === norm(p.path).toLowerCase() || d.startsWith(norm(p.path).toLowerCase() + path.sep))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

export function hookLine(reg, dir) {
  const p = projectAt(reg, dir);
  if (!p) return "";
  const next = nextStep(p.stage);
  if (!next) return "";
  return `/new-project: "${p.name}" is at stage "${p.stage}". Next: ${next}. Run /new-project resume ${p.name} to continue.`;
}

function show(p) {
  const bits = [p.stage, p.kind, p.github && `github ${p.github}${p.visibility ? ` (${p.visibility})` : ""}`].filter(Boolean);
  const missing = existsSync(p.path) ? "" : "  [folder missing]";
  return `${p.name}  ${slash(p.path)}  ${bits.join(" · ")}${missing}`;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const args = [];
  let name;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--name") name = rest[++i];
    else if (!rest[i].startsWith("--")) args.push(rest[i]);
  }
  const h = home();
  const reg = load(h);
  const need = (what) => {
    if (!args[0]) throw new Error(`${cmd} needs ${what}`);
    return args[0];
  };
  const get = () => {
    const p = find(reg, need("a project name or folder"));
    if (!p) throw new Error(`no registered project ${args[0]}; see: projects.mjs list`);
    return p;
  };
  switch (cmd) {
    case "roots":
      if (!reg.roots.length) console.log("No project folders remembered yet. Add one: projects.mjs add-root <dir>");
      for (const r of reg.roots) console.log(`${r.default ? "*" : " "} ${slash(r.path)}${existsSync(r.path) ? "" : "  [missing]"}`);
      return;
    case "add-root": {
      const r = addRoot(reg, need("a folder"), { makeDefault: flags.has("--default"), create: flags.has("--create") });
      save(reg, h);
      console.log(`remembered ${slash(r.path)}${r.default ? " (default)" : ""}`);
      return;
    }
    case "remove-root":
      removeRoot(reg, need("a folder"));
      save(reg, h);
      console.log(`forgot ${slash(norm(args[0]))}`);
      return;
    case "default-root": {
      const r = addRoot(reg, need("a folder"), { makeDefault: true });
      save(reg, h);
      console.log(`default: ${slash(r.path)}`);
      return;
    }
    case "list":
      if (flags.has("--json")) return void console.log(JSON.stringify(reg.projects, null, 2));
      if (!reg.projects.length) console.log("No projects registered yet. Start one with /new-project.");
      for (const p of reg.projects) console.log(show(p));
      return;
    case "add": {
      const dir = need("a folder");
      if (!existsSync(dir)) throw new Error(`${dir} does not exist`);
      const p = addProject(reg, dir, { name });
      save(reg, h);
      console.log(`registered ${show(p)}`);
      return;
    }
    case "get": {
      const p = get();
      console.log(flags.has("--json") ? JSON.stringify(p, null, 2) : `${show(p)}\nnext: ${nextStep(p.stage) ?? "nothing, it is deployed"}`);
      return;
    }
    case "set": {
      const p = get();
      setFields(p, args.slice(1));
      save(reg, h);
      console.log(show(p));
      return;
    }
    case "remove": {
      const p = get();
      reg.projects = reg.projects.filter((x) => x !== p);
      save(reg, h);
      console.log(`forgot ${p.name} (its files are untouched)`);
      return;
    }
    case "scan": {
      const found = scan(reg);
      if (!found.length) console.log("Every git repo under the remembered folders is registered.");
      for (const f of found) console.log(slash(f));
      return;
    }
    default:
      throw new Error("usage: projects.mjs roots | add-root | remove-root | default-root | list | add | get | set | remove | scan | --hook");
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === "--self-test") {
    console.log("ok project");
  } else if (process.argv[2] === "--hook") {
    // A hook must never block a session start.
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      try {
        const text = raw.replace(/^﻿/, "").trim();
        const input = text ? JSON.parse(text) : {};
        const line = hookLine(load(), input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
        if (line) console.log(line);
      } catch {
        // stay silent
      }
    });
  } else {
    try {
      main(process.argv.slice(2));
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }
}
