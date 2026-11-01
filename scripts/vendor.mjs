#!/usr/bin/env node
// Copies third-party skills listed in vendor.json into this repo, unmodified, and records the
// upstream commit and a sha256 of every copied file in vendor.lock.json.
//
//   node scripts/vendor.mjs sync [name...] [--ref TAG]   fetch, copy, and update the lock
//   node scripts/vendor.mjs verify                       check the copies against the lock
//
// sync makes a shallow sparse clone in a temp folder, so it needs git and network access.
// Line endings are taken as upstream stores them (core.autocrlf=false, core.eol=lf); this
// repo's .gitattributes keeps them that way on checkout, so the hashes hold on every OS.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGINS, REPO } from "./layout.mjs";

export { REPO };
const slash = (p) => p.replace(/\\/g, "/");
const GIT = ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "-c", "advice.detachedHead=false"];

export function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
}

export function manifest(repo = REPO) {
  const m = readJson(path.join(repo, "vendor.json"), {});
  return Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith("$")));
}

export function lock(repo = REPO) {
  return readJson(path.join(repo, "vendor.lock.json"), {});
}

export function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(slash(path.relative(base, p)));
  }
  return out;
}

// version = the ref without a leading "v" or "skill-v" (v0.9.96 -> 0.9.96).
export const versionOf = (ref) => ref.replace(/^(?:[a-z-]*-)?v(?=\d)/, "");

// Expands an entry's `files` map against an upstream checkout into [{ dest, src }] per file.
export function expand(entry, checkout) {
  const files = [];
  const dirs = [];
  for (const [dest, src] of Object.entries(entry.files)) {
    const abs = path.join(checkout, src);
    if (!existsSync(abs)) throw new Error(`upstream has no ${src}`);
    if (statSync(abs).isDirectory()) {
      dirs.push(dest);
      for (const rel of walk(abs)) files.push({ dest: `${dest}/${rel}`, src: `${src}/${rel}` });
    } else {
      files.push({ dest, src });
    }
  }
  const seen = new Set();
  for (const f of files) {
    if (seen.has(f.dest)) throw new Error(`two upstream files map to ${f.dest}`);
    seen.add(f.dest);
  }
  return { files, dirs };
}

function clone(entry, ref, log) {
  const tmp = mkdtempSync(path.join(tmpdir(), "cpt-vendor-"));
  const git = (...args) => execFileSync("git", [...GIT, ...args], { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  log(`cloning ${entry.repo} at ${ref}`);
  git("clone", "--quiet", "--depth", "1", "--branch", ref, "--filter=blob:none", "--no-checkout", entry.repo, ".");
  const patterns = Object.values(entry.files).flatMap((src) => [`/${src}`, `/${src}/`]);
  git("sparse-checkout", "set", "--no-cone", ...patterns);
  git("checkout", "--quiet");
  return { dir: tmp, commit: git("rev-parse", "HEAD") };
}

// Fetches one vendored package and replaces its files here. `fetch` is injectable for tests:
// it returns { dir, commit } for an upstream checkout.
export function sync(name, { ref, repo = REPO, log = console.log, fetch = clone } = {}) {
  const m = readJson(path.join(repo, "vendor.json"), {});
  const entry = m[name];
  if (!entry || name.startsWith("$")) throw new Error(`vendor.json has no "${name}"`);
  const useRef = ref ?? entry.ref;
  const { dir, commit } = fetch(entry, useRef, log);
  try {
    const { files, dirs } = expand(entry, dir);
    const locks = lock(repo);
    const others = new Set(Object.entries(locks).filter(([k]) => k !== name).flatMap(([, l]) => Object.keys(l.files)));
    const clash = files.find((f) => others.has(f.dest));
    if (clash) throw new Error(`${clash.dest} already belongs to another vendored package`);

    for (const old of Object.keys(locks[name]?.files ?? {})) rmSync(path.join(repo, old), { force: true });
    const hashes = {};
    for (const f of files) {
      const to = path.join(repo, f.dest);
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(path.join(dir, f.src), to);
      hashes[f.dest] = sha256(to);
    }
    for (const [dest, template] of Object.entries(entry.generated ?? {})) {
      const to = path.join(repo, dest);
      mkdirSync(path.dirname(to), { recursive: true });
      writeFileSync(to, template.replaceAll("{version}", versionOf(useRef)));
      hashes[dest] = sha256(to);
    }
    const sorted = Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : 1)));
    locks[name] = { repo: entry.repo, ref: useRef, commit, license: entry.license, dirs: dirs.sort(), files: sorted };
    writeFileSync(path.join(repo, "vendor.lock.json"), JSON.stringify(locks, null, 2) + "\n");
    if (useRef !== entry.ref) {
      m[name].ref = useRef;
      writeFileSync(path.join(repo, "vendor.json"), JSON.stringify(m, null, 2) + "\n");
    }
    log(`${name}: ${Object.keys(sorted).length} files from ${entry.repo} ${useRef} (${commit.slice(0, 12)})`);
    return locks[name];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Vendored files land in a plugin's skills/ or agents/ folder, or in extras/ (see layout.mjs).
export function placed(dest) {
  if (dest.startsWith("extras/")) return true;
  return Object.values(PLUGINS).some((p) => dest.startsWith(`${p.dir}/skills/`) || dest.startsWith(`${p.dir}/agents/`));
}

// Returns a list of problems; empty means every vendored file matches the lock.
export function verify(repo = REPO) {
  const m = manifest(repo);
  const locks = lock(repo);
  const problems = [];
  for (const name of Object.keys(m)) {
    for (const dest of [...Object.keys(m[name].files ?? {}), ...Object.keys(m[name].generated ?? {})]) {
      if (!placed(dest)) problems.push(`${name}: ${dest} is outside every plugin's skills/ and agents/ and outside extras/`);
    }
    const l = locks[name];
    if (!l) {
      problems.push(`${name}: not in vendor.lock.json (run: node scripts/vendor.mjs sync ${name})`);
      continue;
    }
    if (l.ref !== m[name].ref) problems.push(`${name}: vendor.json wants ${m[name].ref}, lock has ${l.ref}`);
    for (const [file, hash] of Object.entries(l.files)) {
      const p = path.join(repo, file);
      if (!existsSync(p)) problems.push(`${file}: missing`);
      else if (sha256(p) !== hash) problems.push(`${file}: changed from upstream ${l.ref}`);
    }
    for (const d of l.dirs ?? []) {
      const abs = path.join(repo, d);
      if (!existsSync(abs)) continue;
      for (const rel of walk(abs)) {
        const file = `${d}/${rel}`;
        if (!(file in l.files) && !/(^|\/)(__pycache__|node_modules)\//.test(file)) problems.push(`${file}: not from upstream (vendored folders take no local files)`);
      }
    }
  }
  for (const name of Object.keys(locks)) if (!(name in m)) problems.push(`${name}: in the lock but not in vendor.json`);
  return problems;
}

// Every repo path that holds vendored (third-party) content.
export function vendoredFiles(repo = REPO) {
  return new Set(Object.values(lock(repo)).flatMap((l) => Object.keys(l.files)));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "sync") {
      let ref;
      const names = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--ref") ref = rest[++i];
        else names.push(rest[i]);
      }
      const targets = names.length ? names : Object.keys(manifest());
      if (ref && targets.length !== 1) throw new Error("--ref needs exactly one package name");
      for (const n of targets) sync(n, { ref });
    } else if (cmd === "verify") {
      const problems = verify();
      for (const p of problems) console.error(p);
      if (problems.length) process.exit(1);
      console.log("vendored files match vendor.lock.json");
    } else {
      console.error("usage: node scripts/vendor.mjs sync [name...] [--ref TAG] | verify");
      process.exit(2);
    }
  } catch (e) {
    console.error(`vendor ${cmd} failed: ${e.message}`);
    process.exit(1);
  }
}
