#!/usr/bin/env node
// The /video skill's helper. It owns the mechanical rules (lengths, sizes, where files go, the
// template, exact versions, how to run npm and the Remotion CLI), so the skill acts on what it
// prints instead of working them out each time.
//
//   node video.mjs doctor [--dir D]                       node, npm, free disk, Remotion projects
//   node video.mjs plan [--length 20s] [--size 1080p] [--fps 30]
//                                                         frames, width and height as JSON
//   node video.mjs paths --slug S [--cwd D]               where the project, storyboard and MP4 go
//   node video.mjs init <dir> [--length L] [--size S] [--fps N]
//                                                         copy the template; never into a non-empty dir
//   node video.mjs install <dir>                          npm install, then Chrome Headless Shell
//   node video.mjs add <dir> <package...>                 exact versions; @remotion/* match remotion
//   node video.mjs still <dir> --frame N[,N...] [--comp ID] [--out F.png] [--scale S] [-- flags]
//   node video.mjs render <dir> [--comp ID] [--out F.mp4] [-- flags]
//   node video.mjs probe <file.mp4> [--dir D]             duration, size and file size as JSON
//   node video.mjs --self-test
//
// Flags after `--` go to the Remotion CLI as they are (for example `-- --gl=swangle`).
// The pure parts are exported for the tests, which run with no npm, network or Remotion.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE = path.join(HERE, "..", "templates", "remotion");
export const ENTRY = "src/index.ts";
export const DEFAULT_COMP = "Main";
export const DEFAULTS = { length: "20s", size: "1080p", fps: "30" };
export const MAX_SECONDS = 600;
export const MIN_NODE = 20;
export const MIN_FREE_GB = 3;

// Named sizes. Width x height in pixels.
export const SIZES = {
  "1080p": [1920, 1080],
  "720p": [1280, 720],
  "1440p": [2560, 1440],
  "4k": [3840, 2160],
  "2160p": [3840, 2160],
  vertical: [1080, 1920],
  portrait: [1080, 1350],
  square: [1080, 1080],
  "16:9": [1920, 1080],
  "9:16": [1080, 1920],
  "4:5": [1080, 1350],
  "1:1": [1080, 1080],
};

// --- Arguments --------------------------------------------------------------------------------

// { _: positionals, flags: { name: value | true }, rest: everything after `--` }.
export function parseArgs(argv) {
  const out = { _: [], flags: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.rest = argv.slice(i + 1);
      break;
    }
    const m = /^--([a-z][\w-]*)(?:=(.*))?$/.exec(a);
    if (!m) out._.push(a);
    else if (m[2] !== undefined) out.flags[m[1]] = m[2];
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out.flags[m[1]] = argv[++i];
    else out.flags[m[1]] = true;
  }
  return out;
}

// --- Plan: length, size, fps ------------------------------------------------------------------

export function parseFps(text = DEFAULTS.fps) {
  const fps = Number(text);
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new Error(`fps must be a whole number from 1 to 120, not "${text}"`);
  return fps;
}

// "20s", "20", "2.5s", "1m", "1m30s", "1:30", "90 seconds" or "450f" -> { frames, seconds }.
export function parseLength(text, fps) {
  const t = String(text).trim().toLowerCase();
  let m = /^(\d+)\s*(?:f|frames?)$/.exec(t);
  let frames = null;
  if (m) frames = Number(m[1]);
  else if ((m = /^(\d+):([0-5]\d)$/.exec(t))) frames = Math.round((Number(m[1]) * 60 + Number(m[2])) * fps);
  else {
    m = /^(?:(\d+(?:\.\d+)?)\s*(?:m|mins?|minutes?))?\s*(?:(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)?)?$/.exec(t);
    if (m && (m[1] || m[2])) frames = Math.round((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * fps);
  }
  if (frames === null) throw new Error(`can't read the length "${text}". Use 20s, 1m, 1m30s, 1:30 or 450f`);
  if (frames < 1) throw new Error(`the length "${text}" is under one frame`);
  if (frames / fps > MAX_SECONDS) throw new Error(`the length "${text}" is over the ${MAX_SECONDS / 60}-minute limit; make it in parts`);
  return { frames, seconds: Math.round((frames / fps) * 100) / 100 };
}

// "1080p", "vertical", "9:16" or "1280x720" -> { width, height, size }.
export function parseSize(text = DEFAULTS.size) {
  const t = String(text).trim().toLowerCase();
  if (Object.hasOwn(SIZES, t)) {
    const [width, height] = SIZES[t];
    return { width, height, size: t };
  }
  const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(t);
  if (!m) throw new Error(`can't read the size "${text}". Use ${Object.keys(SIZES).join(", ")} or WxH such as 1280x720`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 16 || height < 16 || width > 7680 || height > 7680) throw new Error(`the size ${width}x${height} is outside 16 to 7680 pixels a side`);
  if (width % 2 || height % 2) throw new Error(`H.264 needs an even width and height, not ${width}x${height}`);
  return { width, height, size: `${width}x${height}` };
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// The whole plan, from the optional --length, --size and --fps values.
export function plan({ length = DEFAULTS.length, size = DEFAULTS.size, fps = DEFAULTS.fps } = {}) {
  const f = parseFps(fps);
  const { frames, seconds } = parseLength(length, f);
  const s = parseSize(size);
  const g = gcd(s.width, s.height);
  const aspect = `${s.width / g}:${s.height / g}`;
  return {
    fps: f,
    frames,
    seconds,
    width: s.width,
    height: s.height,
    size: s.size,
    aspect,
    summary: `${seconds} s at ${f} fps = ${frames} frames, ${s.width}x${s.height} (${aspect})`,
  };
}

// The template's src/settings.ts for a plan.
export function settingsSource({ fps, width, height, frames }) {
  return [
    "// Written by `video.mjs init` from the plan. Root.tsx reads it, so change the size, fps or",
    "// length here and nowhere else.",
    "export const VIDEO = {",
    `  fps: ${fps},`,
    `  width: ${width},`,
    `  height: ${height},`,
    `  durationInFrames: ${frames},`,
    "};",
    "",
  ].join("\n");
}

// --- Paths ------------------------------------------------------------------------------------

// A short kebab-case folder name from free text.
export function slugify(text) {
  const s = String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!s) return "video";
  if (s.length <= 40) return s;
  const cut = s.slice(0, 40);
  return cut.includes("-") ? cut.slice(0, cut.lastIndexOf("-")) : cut;
}

// Local date as YYYY-MM-DD.
export const dateStamp = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// The top folder of the git repo that holds `start`, or null.
export function findGitRoot(start, exists = existsSync) {
  let dir = path.resolve(start);
  for (;;) {
    if (exists(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// Where one video's files go. In a git repo: <repo>/videos/<date>-<slug>/; elsewhere:
// ~/.claude/video/<date>-<slug>/. A folder that already exists gets -2, -3, ... so a new video
// never lands in an old one.
export function outputPaths({ slug, cwd = process.cwd(), home = homedir(), date = new Date(), exists = existsSync }) {
  const s = slugify(slug);
  const repo = findGitRoot(cwd, exists);
  const base = repo ? path.join(repo, "videos") : path.join(home, ".claude", "video");
  const stem = `${dateStamp(date)}-${s}`;
  let name = stem;
  for (let n = 2; exists(path.join(base, name)); n++) name = `${stem}-${n}`;
  const root = path.join(base, name);
  const project = path.join(root, "project");
  return {
    root,
    project,
    storyboard: path.join(root, "storyboard.md"),
    stills: path.join(project, "out", "stills"),
    video: path.join(root, `${s}.mp4`),
    inRepo: Boolean(repo),
    repo,
  };
}

// --- Template and versions --------------------------------------------------------------------

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const isRemotion = (name) => name === "remotion" || name.startsWith("@remotion/");

// Problems with a package.json's pins: every version exact, every Remotion package the same one.
export function checkPins(pkg) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const problems = [];
  for (const [name, v] of Object.entries(deps)) if (!/^\d+\.\d+\.\d+$/.test(v)) problems.push(`${name}@${v} isn't an exact version`);
  const remotion = [...new Set(Object.entries(deps).filter(([n]) => isRemotion(n)).map(([, v]) => v))];
  if (!deps.remotion) problems.push("remotion isn't a dependency");
  if (remotion.length > 1) problems.push(`the Remotion packages are on different versions: ${remotion.join(", ")}`);
  return problems;
}

// "name" or "name@version" (scoped names too). Starts with a letter, digit or @, so it can't be an option.
const PKG_SPEC = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*-]+)?$/i;

export function splitSpec(spec) {
  const at = spec.indexOf("@", 1);
  return at === -1 ? [spec, null] : [spec.slice(0, at), spec.slice(at + 1)];
}

// The npm install arguments for `add`: @remotion/* get remotion's exact version, others stay as given.
export function pinPackages(specs, remotionVersion) {
  if (!specs.length) throw new Error("name at least one package to add");
  return specs.map((spec) => {
    if (!PKG_SPEC.test(spec)) throw new Error(`not a package name: ${spec}`);
    const [name, v] = splitSpec(spec);
    if (!isRemotion(name)) return spec;
    if (v && v !== remotionVersion) throw new Error(`${name} must be ${remotionVersion}, the project's remotion version, not ${v}`);
    return `${name}@${remotionVersion}`;
  });
}

// Copies the template into dir, which must be missing or empty, and writes src/settings.ts.
export function init(dir, p = plan(), template = TEMPLATE) {
  const target = path.resolve(dir);
  if (existsSync(target) && readdirSync(target).length) throw new Error(`${target} isn't empty. Pick a new folder, or work on the project that's there`);
  mkdirSync(target, { recursive: true });
  cpSync(template, target, { recursive: true, filter: (src) => !src.split(/[\\/]/).includes("node_modules") });
  // npm and git tooling treat a file named .gitignore specially, so the template ships it as gitignore.
  if (existsSync(path.join(target, "gitignore"))) renameSync(path.join(target, "gitignore"), path.join(target, ".gitignore"));
  writeFileSync(path.join(target, "src", "settings.ts"), settingsSource(p));
  return { dir: target, plan: p };
}

// --- Running npm and the Remotion CLI ---------------------------------------------------------

// One argument quoted for cmd.exe: inside double quotes & | < > ^ and spaces are plain text, and
// trailing backslashes are doubled so they don't escape the closing quote. cmd expands %VAR% even
// inside quotes, and an inner quote would end the quoting, so those are refused, not passed wrong.
export function cmdQuote(arg) {
  if (/[%"\r\n]/.test(arg)) throw new Error(`can't pass ${JSON.stringify(arg)} through cmd.exe`);
  return `"${arg.replace(/(\\+)$/, "$1$1")}"`;
}

// How to run `npm args`. First choice: the npm-cli.js that ships next to this node (Windows:
// <node dir>/node_modules/npm; Unix: <node dir>/../lib/node_modules/npm), run with node itself, so
// there's no shell and no quoting. Otherwise npm from PATH: on Windows that is npm.cmd, which Node
// only starts through cmd.exe, so it gets its full path and one quoted command line (not an args
// array with shell: true, which splits arguments with spaces and is DEP0190).
export function npmCommand(args, { platform = process.platform, env = process.env, node = process.execPath, exists = existsSync } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const nodeDir = p.dirname(node);
  const clis = [
    env.npm_execpath && /npm-cli\.js$/.test(env.npm_execpath) ? env.npm_execpath : null,
    p.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    p.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  const cli = clis.find((f) => exists(f));
  if (cli) return { file: node, args: [cli, ...args], shell: false };
  if (platform !== "win32") return { file: "npm", args, shell: false };
  // A PATH entry can carry stray quotes, which stop cmd.exe's own search, so look it up here.
  const dirs = (env.PATH || env.Path || "").split(";").map((d) => d.replace(/"/g, "").trim()).filter(Boolean);
  const found = dirs.map((d) => path.win32.join(d, "npm.cmd")).find((f) => exists(f)) ?? "npm.cmd";
  return { file: [found, ...args].map(cmdQuote).join(" "), args: [], shell: true };
}

// The project's own Remotion CLI, run with this node: no npx, no shell, nothing fetched.
export function remotionCommand(dir, args, { node = process.execPath, exists = existsSync, read = readJson } = {}) {
  const pkg = path.join(path.resolve(dir), "node_modules", "@remotion", "cli", "package.json");
  if (!exists(pkg)) throw new Error(`Remotion isn't installed in ${path.resolve(dir)}. Run: video.mjs install "${path.resolve(dir)}"`);
  const bin = read(pkg).bin;
  const rel = typeof bin === "string" ? bin : bin?.remotion;
  if (!rel) throw new Error(`${pkg} names no remotion bin`);
  return { file: node, args: [path.join(path.dirname(pkg), rel), ...args], shell: false };
}

export function stillArgs({ comp = DEFAULT_COMP, frame, out, scale, rest = [] }) {
  return ["still", ENTRY, comp, out, `--frame=${frame}`, ...(scale ? [`--scale=${scale}`] : []), ...rest];
}

export const renderArgs = ({ comp = DEFAULT_COMP, out, rest = [] }) => ["render", ENTRY, comp, out, ...rest];

// "45" or "45,150,300" -> [45, 150, 300].
export function parseFrames(text) {
  const frames = String(text ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!frames.length || frames.some((f) => !/^\d+$/.test(f))) throw new Error(`--frame takes frame numbers such as 45 or 45,150,300, not "${text}"`);
  return frames.map(Number);
}

export const stillPath = (dir, comp, frame) => path.join(path.resolve(dir), "out", "stills", `${comp}-${String(frame).padStart(4, "0")}.png`);

// The environment for a child: this node's folder first on PATH, so install scripts that run
// `node ...` through a shell (esbuild's does) find it even when a later PATH entry is broken.
export function childEnv(env = process.env, node = process.execPath, platform = process.platform) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const sep = platform === "win32" ? ";" : ":";
  return { ...env, [key]: [p.dirname(node), env[key]].filter(Boolean).join(sep) };
}

function run(cmd, cwd, capture = false) {
  return spawnSync(cmd.file, cmd.args, {
    cwd,
    env: childEnv(),
    shell: cmd.shell,
    windowsHide: true,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

// --- Probe ------------------------------------------------------------------------------------

export function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

// The report line's facts from ffprobe's JSON (-show_format -show_streams) and the file size.
export function summarize(probe, bytes) {
  const streams = probe?.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const [num, den] = String(video?.r_frame_rate ?? "").split("/").map(Number);
  const duration = Number(probe?.format?.duration ?? video?.duration);
  return {
    bytes,
    fileSize: humanBytes(bytes),
    duration: Number.isFinite(duration) ? Math.round(duration * 100) / 100 : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: num && den ? Math.round((num / den) * 100) / 100 : null,
    codec: video?.codec_name ?? null,
    audio: streams.some((s) => s.codec_type === "audio"),
  };
}

// ffprobe through the project's Remotion CLI (it ships one), else ffprobe on PATH, else size only.
export function probe(file, dir) {
  const abs = path.resolve(file);
  if (!existsSync(abs)) throw new Error(`no file at ${abs}`);
  const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", abs];
  const tries = [];
  if (dir) {
    try {
      tries.push([remotionCommand(dir, ["ffprobe", ...args]), dir]);
    } catch {}
  }
  tries.push([{ file: "ffprobe", args, shell: false }, path.dirname(abs)]);
  let data = null;
  for (const [cmd, cwd] of tries) {
    const r = run(cmd, cwd, true);
    if (r.status !== 0 || !r.stdout) continue;
    const start = r.stdout.indexOf("{");
    try {
      data = JSON.parse(r.stdout.slice(start));
      break;
    } catch {}
  }
  return { file: abs, ...summarize(data, statSync(abs).size) };
}

// --- Doctor -----------------------------------------------------------------------------------

// The nearest folder that exists, for statfs on a path that isn't made yet.
function existing(p) {
  let dir = path.resolve(p);
  while (!existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}

export function freeGB(p) {
  try {
    const s = statfsSync(existing(p));
    return Math.round(((s.bavail * s.bsize) / 1024 ** 3) * 10) / 10;
  } catch {
    return null;
  }
}

// What a folder holds: a Remotion project or not, installed or not, and its pin problems.
export function projectInfo(dir) {
  const pkgFile = path.join(dir, "package.json");
  if (!existsSync(pkgFile)) return null;
  let pkg;
  try {
    pkg = readJson(pkgFile);
  } catch {
    return null;
  }
  const remotion = pkg.dependencies?.remotion ?? pkg.devDependencies?.remotion;
  if (!remotion) return null;
  return {
    dir: path.resolve(dir),
    remotion,
    installed: existsSync(path.join(dir, "node_modules", "@remotion", "cli", "package.json")),
    pins: checkPins(pkg),
  };
}

// Remotion projects already made: this folder, and the newest under videos/ and ~/.claude/video/.
export function findProjects(cwd, home = homedir()) {
  const found = [];
  const here = projectInfo(cwd);
  if (here) found.push(here);
  const repo = findGitRoot(cwd);
  for (const base of [repo && path.join(repo, "videos"), path.join(home, ".claude", "video")].filter(Boolean)) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort().reverse().slice(0, 10)) {
      const info = projectInfo(path.join(base, name, "project"));
      if (info && !found.some((f) => f.dir === info.dir)) found.push(info);
    }
  }
  return found;
}

export function doctor({ dir = process.cwd() } = {}) {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const npm = run(npmCommand(["--version"]), process.cwd(), true);
  const npmVersion = npm.status === 0 ? npm.stdout.trim() : null;
  const ffmpeg = run({ file: "ffmpeg", args: ["-version"], shell: false }, process.cwd(), true).status === 0;
  const free = freeGB(dir);
  const projects = findProjects(dir);
  const report = {
    node: { version: process.versions.node, ok: nodeMajor >= MIN_NODE, need: `${MIN_NODE}+` },
    npm: { version: npmVersion, ok: Boolean(npmVersion) },
    disk: { path: existing(dir), freeGB: free, ok: free === null || free >= MIN_FREE_GB, need: `${MIN_FREE_GB} GB for node_modules, the browser and renders` },
    ffmpeg: { onPath: ffmpeg, note: "optional: Remotion bundles its own ffmpeg; only post-processing needs this one" },
    projects,
  };
  report.ok = report.node.ok && report.npm.ok && report.disk.ok;
  return report;
}

// --- Self-test --------------------------------------------------------------------------------

export function selfTest() {
  const p = plan();
  assert.equal(p.frames, 600);
  assert.equal(`${p.width}x${p.height}`, "1920x1080");
  assert.equal(parseLength("1m30s", 30).frames, 2700);
  assert.equal(parseSize("vertical").height, 1920);
  assert.equal(slugify("A 20 second CLI teaser!"), "a-20-second-cli-teaser");
  assert.equal(cmdQuote("a b&c"), '"a b&c"');
  const pkg = readJson(path.join(TEMPLATE, "package.json"));
  assert.deepEqual(checkPins(pkg), []);
  for (const f of [ENTRY, "src/Root.tsx", "src/settings.ts", "remotion.config.ts", "tsconfig.json", "gitignore"]) assert.ok(existsSync(path.join(TEMPLATE, f)), `template is missing ${f}`);
  assert.equal(readFileSync(path.join(TEMPLATE, "src", "settings.ts"), "utf8").replace(/\r\n/g, "\n"), settingsSource(p));
  return `ok video.mjs: plan, paths and the template (remotion ${pkg.dependencies.remotion}) check out`;
}

// --- CLI --------------------------------------------------------------------------------------

const print = (obj) => console.log(JSON.stringify(obj, null, 2));
const planFrom = (flags) => plan({ length: flags.length, size: flags.size, fps: flags.fps });
const value = (flags, name) => (typeof flags[name] === "string" ? flags[name] : undefined);

function needDir(a, cmd) {
  const dir = a._[1];
  if (!dir) throw new Error(`usage: video.mjs ${cmd} <dir> ...`);
  return path.resolve(dir);
}

export function main(argv) {
  const a = parseArgs(argv);
  const cmd = a._[0];
  if (a.flags["self-test"]) return console.log(selfTest());
  switch (cmd) {
    case "doctor":
      return print(doctor({ dir: value(a.flags, "dir") }));
    case "plan":
      return print(planFrom(a.flags));
    case "paths": {
      const slug = value(a.flags, "slug");
      if (!slug) throw new Error("usage: video.mjs paths --slug <slug> [--cwd <dir>]");
      return print(outputPaths({ slug, cwd: value(a.flags, "cwd") }));
    }
    case "init": {
      const r = init(needDir(a, "init"), planFrom(a.flags));
      return print({ ...r, next: `video.mjs install "${r.dir}"` });
    }
    case "install": {
      const dir = needDir(a, "install");
      if (!projectInfo(dir)) throw new Error(`${dir} isn't a Remotion project. Run video.mjs init first`);
      const r = run(npmCommand(["install", "--no-audit", "--no-fund"]), dir);
      if (r.status !== 0) throw new Error(`npm install failed (exit ${r.status ?? r.error?.message})`);
      const b = run(remotionCommand(dir, ["browser", "ensure"]), dir);
      if (b.status !== 0) throw new Error(`the Remotion browser download failed (exit ${b.status ?? b.error?.message})`);
      return console.log(`installed: ${dir}`);
    }
    case "add": {
      const dir = needDir(a, "add");
      const info = projectInfo(dir);
      if (!info) throw new Error(`${dir} isn't a Remotion project`);
      const specs = pinPackages(a._.slice(2), info.remotion);
      const r = run(npmCommand(["install", "--save-exact", "--no-audit", "--no-fund", ...specs]), dir);
      if (r.status !== 0) throw new Error(`npm install failed (exit ${r.status ?? r.error?.message})`);
      return console.log(`added: ${specs.join(" ")}`);
    }
    case "still": {
      const dir = needDir(a, "still");
      const comp = value(a.flags, "comp") ?? DEFAULT_COMP;
      const frames = parseFrames(a.flags.frame);
      const out = value(a.flags, "out");
      if (out && frames.length > 1) throw new Error("--out names one file, so it takes one --frame");
      let failed = 0;
      for (const frame of frames) {
        const file = out ? path.resolve(out) : stillPath(dir, comp, frame);
        mkdirSync(path.dirname(file), { recursive: true });
        const r = run(remotionCommand(dir, stillArgs({ comp, frame, out: file, scale: value(a.flags, "scale"), rest: a.rest })), dir);
        if (r.status === 0) console.log(`still: ${file}`);
        else {
          failed++;
          console.log(`still failed: frame ${frame} (exit ${r.status ?? r.error?.message})`);
        }
      }
      if (failed) process.exitCode = 1;
      return;
    }
    case "render": {
      const dir = needDir(a, "render");
      const comp = value(a.flags, "comp") ?? DEFAULT_COMP;
      const out = path.resolve(value(a.flags, "out") ?? path.join(dir, "out", `${comp}.mp4`));
      mkdirSync(path.dirname(out), { recursive: true });
      const r = run(remotionCommand(dir, renderArgs({ comp, out, rest: a.rest })), dir);
      if (r.status !== 0) throw new Error(`render failed (exit ${r.status ?? r.error?.message})`);
      return print(probe(out, dir));
    }
    case "probe": {
      const file = a._[1];
      if (!file) throw new Error("usage: video.mjs probe <file.mp4> [--dir <project>]");
      return print(probe(file, value(a.flags, "dir")));
    }
    default:
      throw new Error("usage: video.mjs doctor | plan | paths | init | install | add | still | render | probe | --self-test");
  }
}

// Compare real paths: a linked install runs this through a junction or symlink.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  }
}
