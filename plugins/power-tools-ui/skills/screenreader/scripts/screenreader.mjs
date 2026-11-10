#!/usr/bin/env node
// Setup and checks for /screenreader: a nonsighted persona tests a web page using only NVDA,
// through the NVDA MCP add-on (github.com/InfiArtt/nvda-mcp) and its nvda-mcp server. The script
// owns every setup rule; the skill acts on what it prints.
//
//   detect                    JSON: NVDA, JAWS, the add-on and its settings, uv, the MCP
//                             registration, warnings, and `next`: the next setup step, or "verify".
//   choose nvda|jaws          Record the owner's screen reader. JAWS can't be driven over MCP yet.
//   install-nvda [--dry-run]  Download the latest stable NVDA from NV Access, check its SHA-1 and
//                             install it silently (Windows asks for admin rights). Also updates an
//                             NVDA older than the add-on needs.
//   install-addon [--dry-run] Download the add-on's latest release, check its SHA-256 and open it,
//                             so NVDA asks the owner to install it. Waits for that, then restarts NVDA.
//   install-uv                Install uv, which runs the nvda-mcp server (winget).
//   register [--replace]      Register the nvda-mcp server with Claude Code for every project,
//                             pinned to the add-on's version.
//   start-nvda | restart-nvda Start (or restart) NVDA and wait until the add-on is listening.
//   allow-keys --apps A,B     Let MCP clients press keys, only in apps A and B ("" means any app).
//                             Quits NVDA, backs up and edits nvda.ini, starts NVDA again. NVDA still
//                             asks once each time it starts, before the first key press.
//   allow-keys --off          Stop MCP clients pressing keys (they can still read).
//   verify                    Start the registered server, list its tools and ask NVDA for its
//                             status. Exit 0 when the persona can work.
//   open URL [--dry-run]      Open an http(s) address in the default browser.
//   paths --slug S [--cwd D]  Where the report and its transcript go.
//   --self-test               Prints "ok".
//
// Configuration (all optional): SCREENREADER_HOME (state and downloads; default
// ~/.claude/screenreader), NVDA_CONFIG_DIR (default %APPDATA%\nvda), CLAUDE_CONFIG_DIR (the folder
// with .claude.json; default the home folder).

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
export const MIN_NVDA = "2026.3";
export const ADDON_ID = "nvdaMcp";
export const ADDON_REPO = "InfiArtt/nvda-mcp";
export const SERVER_PACKAGE = "nvda-mcp";
export const MCP_NAME = "nvda";
const UPDATE_URL = "https://api.nvaccess.org/nvdaUpdateCheck?versionType=stable";
const UNINSTALL_KEY = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NVDA";
const BROWSER_KEY = "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice";

// What the persona may use: what an NVDA user does with a keyboard and their ears. Pressing keys,
// typing, hearing speech, NVDA's Elements List, find, browse/focus mode, Say All and Alt+Tab.
export const PERSONA_TOOLS = [
  "nvda_get_status", "nvda_press_keys", "nvda_type_text", "nvda_get_speech_history", "nvda_wait_for_speech",
  "nvda_get_focus", "nvda_set_document_mode", "nvda_find_in_page", "nvda_list_elements", "nvda_move_to_element",
  "nvda_get_text", "nvda_list_windows", "nvda_activate_window",
];
// Never the persona's: tools that show what a sighted developer sees (a picture, the HTML, the raw
// accessibility tree) or that act on a control without the keyboard.
export const SIGHTED_TOOLS = [
  "nvda_capture_control", "nvda_inspect_html", "nvda_find_html", "nvda_get_object_tree", "nvda_inspect_object",
  "nvda_find_objects", "nvda_focus_object", "nvda_activate_object", "nvda_set_value", "nvda_run_script", "nvda_run_scenario",
];

export const home = () => process.env.SCREENREADER_HOME || path.join(homedir(), ".claude", "screenreader");
const stateFile = () => path.join(home(), "state.json");
export const nvdaConfigDir = (env = process.env) => env.NVDA_CONFIG_DIR || path.join(env.APPDATA || path.join(homedir(), "AppData", "Roaming"), "nvda");
const claudeJsonFile = (env = process.env) => (env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(homedir(), ".claude.json"));
const fwd = (p) => p.replace(/\\/g, "/");
const readText = (file) => { try { return readFileSync(file, "utf8"); } catch { return null; } };
const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readState() {
  return readJson(stateFile(), {});
}

function writeState(next) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify(next, null, 2) + "\n");
}

// "2026.3.1.58288" is at least "2026.3".
export function versionAtLeast(version, min) {
  const a = String(version ?? "").split(".").map((n) => Number.parseInt(n, 10));
  const b = String(min).split(".").map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(a[0])) return false;
  for (let i = 0; i < b.length; i++) {
    const x = Number.isFinite(a[i]) ? a[i] : 0;
    if (x !== b[i]) return x > b[i];
  }
  return true;
}

// ---- nvda.ini: a ConfigObj file. Top-level sections are "[name]" at the start of a line;
// subsections are "[[name]]", indented. ----

const isTopHeader = (line) => /^\[[^[]/.test(line);
const isSubHeader = (line) => /^\s*\[\[/.test(line);

// One top-level section's own keys (not its subsections'), with quotes taken off.
export function iniSection(text, name) {
  const out = {};
  let inside = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (isTopHeader(line)) { inside = line.trim() === `[${name}]`; continue; }
    if (isSubHeader(line)) { if (inside) inside = false; continue; }
    if (!inside) continue;
    const kv = /^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^"(.*)"$|^'(.*)'$/, (_, a, b) => a ?? b);
  }
  return out;
}

// The add-on's settings, with the add-on's own defaults for anything nvda.ini doesn't set.
export function addonSettings(text) {
  const s = iniSection(text, ADDON_ID);
  const bool = (v, d) => (v == null ? d : /^(true|1|yes|on)$/i.test(v));
  return {
    enabled: bool(s.enabled, true),
    allowControl: bool(s.allowControl, false),
    confirmControl: bool(s.confirmControl, true),
    allowedApps: String(s.allowedApps ?? "").split(",").map((a) => a.trim()).filter(Boolean),
  };
}

// Sets keys in one top-level section and keeps everything else: comments, order, line endings.
// A value with a comma is quoted, or ConfigObj would read it as a list.
export function setIniValues(text, name, values) {
  const eol = String(text).includes("\r\n") ? "\r\n" : "\n";
  const lines = text ? String(text).split(/\r?\n/) : [];
  const fmt = (v) => {
    if (typeof v === "boolean") return v ? "True" : "False";
    const s = String(v).replace(/"/g, "");
    return s === "" || /[,#'\s]/.test(s) ? `"${s}"` : s;
  };
  const pending = new Map(Object.entries(values));
  const start = lines.findIndex((l) => l.trim() === `[${name}]` && isTopHeader(l));
  if (start < 0) {
    const trailing = lines.length && lines.at(-1) === "" ? [""] : [];
    while (lines.length && lines.at(-1) === "") lines.pop();
    return [...lines, `[${name}]`, ...[...pending].map(([k, v]) => `${k} = ${fmt(v)}`), ...(trailing.length ? trailing : [""])].join(eol);
  }
  let end = lines.findIndex((l, i) => i > start && (isTopHeader(l) || isSubHeader(l)));
  if (end < 0) end = lines.length;
  for (let i = start + 1; i < end; i++) {
    const kv = /^(\s*)([A-Za-z_]\w*)\s*=/.exec(lines[i]);
    if (kv && pending.has(kv[2])) {
      lines[i] = `${kv[1]}${kv[2]} = ${fmt(pending.get(kv[2]))}`;
      pending.delete(kv[2]);
    }
  }
  let at = end;
  while (at > start + 1 && lines[at - 1].trim() === "") at--;
  const indent = lines.slice(start + 1, end).map((l) => /^(\s*)[A-Za-z_]\w*\s*=/.exec(l)?.[1]).find((i) => i !== undefined) ?? "";
  lines.splice(at, 0, ...[...pending].map(([k, v]) => `${indent}${k} = ${fmt(v)}`));
  return lines.join(eol);
}

// ---- what is on this machine ----

// NV Access's update service: "key: value" lines (version, launcherUrl, launcherHash = SHA-1).
export function parseUpdateInfo(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf(": ");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 2).trim();
  }
  if (!out.version || !out.launcherUrl) throw new Error("NV Access's update service gave no version or download address");
  return { version: out.version, url: out.launcherUrl.split(" ")[0], sha1: out.launcherHash ? out.launcherHash.toLowerCase() : null };
}

const BROWSERS = [[/^ChromeHTML/i, "chrome"], [/^MSEdge/i, "msedge"], [/^Firefox/i, "firefox"], [/^Brave/i, "brave"], [/^Opera/i, "opera"], [/^Vivaldi/i, "vivaldi"]];
// The default browser's program name, as NVDA names applications (the .exe without ".exe").
export const browserApp = (progId) => BROWSERS.find(([re]) => re.test(progId ?? ""))?.[1] ?? null;

// The nvda server as Claude Code has it: user scope (~/.claude.json), this folder's local scope,
// or the project's .mcp.json. null when it isn't registered.
export function mcpRegistration(claudeJson, cwd = process.cwd(), projectMcp = readJson(path.join(cwd, ".mcp.json"), null)) {
  const pick = (scope, s) => ({ scope, type: s.type ?? "stdio", command: s.command ?? null, args: s.args ?? [], env: s.env ?? {}, url: s.url ?? null });
  const same = (a, b) => fwd(path.resolve(a)).toLowerCase() === fwd(path.resolve(b)).toLowerCase();
  if (claudeJson?.mcpServers?.[MCP_NAME]) return pick("user", claudeJson.mcpServers[MCP_NAME]);
  for (const [dir, p] of Object.entries(claudeJson?.projects ?? {})) {
    if (same(dir, cwd) && p?.mcpServers?.[MCP_NAME]) return pick("local", p.mcpServers[MCP_NAME]);
  }
  if (projectMcp?.mcpServers?.[MCP_NAME]) return pick("project", projectMcp.mcpServers[MCP_NAME]);
  return null;
}

// "uvx nvda-mcp==1.1.0" is pinned to 1.1.0; a plain "nvda-mcp" isn't pinned.
export const pinnedVersion = (reg) => (reg?.args ?? []).map((a) => new RegExp(`^${SERVER_PACKAGE}==(.+)$`).exec(a)?.[1]).find(Boolean) ?? null;

function regValue(key, name) {
  try {
    const out = execFileSync("reg", ["query", key, "/v", name], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    return new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`).exec(out)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export function nvdaRunning() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq nvda.exe", "/NH"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    return /\bnvda\.exe\b/i.test(out);
  } catch {
    return false;
  }
}

// One argument for a cmd.exe command line. cmd expands % and splits on quotes, so those are refused.
export function cmdQuote(arg) {
  if (/[%"\r\n]/.test(arg)) throw new Error(`can't pass ${JSON.stringify(arg)} through cmd.exe`);
  return `"${String(arg).replace(/(\\+)$/, "$1$1")}"`;
}

// Where uv puts uvx; winget's installer adds these to PATH, but programs already running
// (this shell, Claude Code) keep the PATH they started with.
const uvDirs = (env) => [
  env.USERPROFILE && path.win32.join(env.USERPROFILE, ".local", "bin"),
  env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"),
].filter(Boolean);

// How to start `name args` without cmd.exe where possible. A bare name is looked up on PATH (and in
// uv's folders) with PATHEXT: an .exe runs directly, a .cmd or .bat gets one quoted command line.
// Looking it up here, not leaving it to cmd, matters: cmd can miss programs that are on PATH.
export function resolveCommand(name, args = [], { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== "win32") return { file: name, args, shell: false };
  const viaCmd = (file) => ({ file: [file, ...args].map(cmdQuote).join(" "), args: [], shell: true });
  const exts = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase());
  const run = (file) => (/\.(cmd|bat)$/i.test(file) ? viaCmd(file) : { file, args, shell: false });
  if (/[\\/]/.test(name)) {
    if (exists(name)) return run(name);
    const found = exts.map((e) => name + e).find((f) => exists(f));
    if (found) return run(found);
    throw new Error(`${name} doesn't exist`);
  }
  const dirs = [...(env.PATH || env.Path || "").split(";").filter(Boolean), ...uvDirs(env)];
  for (const dir of dirs) {
    if (path.extname(name) && exists(path.win32.join(dir, name))) return run(path.win32.join(dir, name));
    for (const ext of exts) {
      const file = path.win32.join(dir, name + ext);
      if (exists(file)) return run(file);
    }
  }
  throw new Error(`${name} isn't on PATH`);
}

function onPath(name) {
  if (process.platform === "win32") {
    try { resolveCommand(name); return true; } catch { return false; }
  }
  try {
    execFileSync("which", [name], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// Everything setup needs to know. The probes are parameters, so tests can stand in for a machine.
export function gatherFacts({ env = process.env, platform = process.platform, cwd = process.cwd(), reg = regValue, running = nvdaRunning, has = onPath, exists = existsSync } = {}) {
  const state = readState();
  const facts = { platform, supported: platform === "win32", reader: state.reader ?? null };
  if (!facts.supported) return facts;
  const dir = reg(UNINSTALL_KEY, "InstallDir");
  const version = reg(UNINSTALL_KEY, "DisplayVersion");
  facts.nvda = { installed: Boolean(dir && exists(path.join(dir, "nvda.exe"))), dir: dir ? fwd(dir) : null, version, recent: versionAtLeast(version, MIN_NVDA), running: running() };
  const cfg = nvdaConfigDir(env);
  const manifest = readText(path.join(cfg, "addons", ADDON_ID, "manifest.ini"));
  facts.addon = {
    installed: manifest != null,
    version: manifest ? /^version\s*=\s*"?([^"\r\n]+?)"?\s*$/m.exec(manifest)?.[1] ?? null : null,
    pending: exists(path.join(cfg, "addons", `${ADDON_ID}.pendingInstall`)),
    listening: exists(path.join(cfg, "nvdaMcp", "connection.json")),
    ...addonSettings(readText(path.join(cfg, "nvda.ini"))),
  };
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  facts.jaws = { installed: exists(path.join(programFiles, "Freedom Scientific", "JAWS")) };
  facts.uv = has("uvx");
  facts.mcp = mcpRegistration(readJson(claudeJsonFile(env), {}), cwd);
  facts.browser = browserApp(reg(BROWSER_KEY, "ProgId"));
  return facts;
}

// The next setup step. Each one changes one thing; after it, detect again.
export function planNext(f) {
  if (!f.supported) return "unsupported"; // NVDA runs on Windows only
  if (f.reader === "jaws") return "jaws";
  if (!f.nvda?.installed) return "install-nvda";
  if (!f.nvda.recent) return "update-nvda";
  if (f.addon?.pending) return "restart-nvda";
  if (!f.addon?.installed) return "install-addon";
  if (!f.mcp) return f.uv ? "register" : "install-uv";
  if (!f.addon.enabled || !f.addon.allowControl) return "allow-keys";
  if (!f.nvda.running) return "start-nvda";
  return "verify";
}

// Things that work but the owner should know.
export function warnings(f) {
  const out = [];
  if (!f.supported) return out;
  if (f.jaws?.installed) out.push("JAWS is installed too. Quit it before a run: two screen readers fight over the keyboard and speech.");
  const pin = pinnedVersion(f.mcp);
  if (f.mcp && f.addon?.version && pin && pin !== f.addon.version) out.push(`The nvda server is pinned to ${pin} but the add-on is ${f.addon.version}. \`register --replace\` pins it to ${f.addon.version}.`);
  if (f.mcp && f.addon?.version && !pin && f.mcp.command) out.push(`The nvda server (${f.mcp.command}) isn't pinned to the add-on's version (${f.addon.version}). If tools fail, \`register --replace\` pins it.`);
  if (f.mcp && f.mcp.type !== "stdio") out.push(`The nvda server is registered as ${f.mcp.type}; verify only checks stdio servers.`);
  if (f.addon?.allowControl && !f.addon.allowedApps.length) out.push(`MCP clients may press keys in every application. \`allow-keys --apps ${f.browser ?? "<browser>"}\` limits them to the browser.`);
  if (f.addon?.allowControl && !f.addon.confirmControl) out.push("NVDA won't ask before the first key press (Ask before the first key press is off in NVDA Settings, NVDA MCP).");
  return out;
}

// ---- downloads and installs ----

async function download(url, file) {
  const r = await fetch(url, { headers: { "user-agent": "claude-power-tools/screenreader" }, signal: AbortSignal.timeout(300_000) });
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status} from ${url}`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}

export const fileHash = (file, algo) => createHash(algo).update(readFileSync(file)).digest("hex");

function checkHash(file, algo, expected) {
  if (!expected) return;
  const got = fileHash(file, algo);
  if (got !== expected.toLowerCase()) {
    rmSync(file, { force: true });
    throw new Error(`the download's ${algo.toUpperCase()} (${got}) doesn't match the published one (${expected}); deleted it`);
  }
}

// The cmd.exe line that starts a program the way Explorer does. Installed NVDA is a uiAccess
// program and its installer asks for admin rights; Windows starts both only that way (a direct
// spawn fails with EACCES). With wait, cmd exits with the program's exit code.
export function shellStartLine(file, args = [], { wait = false } = {}) {
  if (!/^[^"%\r\n]+$/.test(file) || args.some((a) => !/^[\w-]+$/.test(a))) throw new Error(`can't start ${file} ${args.join(" ")} through cmd.exe`);
  return `"start "" ${wait ? "/wait " : ""}"${file}"${args.map((a) => ` ${a}`).join("")}"`;
}

function shellStart(file, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("cmd.exe", ["/d", "/s", "/c", shellStartLine(file, args, opts)], { windowsVerbatimArguments: true, windowsHide: true, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
}

async function waitFor(check, ms, every = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(every);
  }
  return check();
}

const nvdaExe = (f) => path.join(f.nvda.dir, "nvda.exe");
const connectionFile = () => path.join(nvdaConfigDir(), "nvdaMcp", "connection.json");

// -r replaces a running copy; -q quits it.
const launchNvda = (f, args = []) => shellStart(nvdaExe(f), args);

async function startNvda({ restart = false } = {}) {
  const f = gatherFacts();
  if (!f.nvda?.installed) throw new Error("NVDA isn't installed: run install-nvda");
  if (f.nvda.running && !restart) return { started: false, running: true, listening: existsSync(connectionFile()) };
  if (restart) rmSync(connectionFile(), { force: true }); // so the wait sees the new one
  await launchNvda(f, f.nvda.running ? ["-r"] : []);
  const listening = await waitFor(() => existsSync(connectionFile()), 30_000);
  return { started: true, running: nvdaRunning(), listening };
}

async function installNvda({ dryRun }) {
  const r = await fetch(UPDATE_URL, { headers: { "user-agent": "claude-power-tools/screenreader" }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`NV Access's update service answered HTTP ${r.status}`);
  const info = parseUpdateInfo(await r.text());
  if (dryRun) return { ...info, dryRun: true };
  const file = await download(info.url, path.join(home(), "downloads", path.basename(new URL(info.url).pathname)));
  checkHash(file, "sha1", info.sha1);
  // --install-silent installs without questions and exits; Windows still asks for admin rights.
  const exitCode = await shellStart(file, ["--install-silent"], { wait: true });
  const f = gatherFacts();
  return { version: info.version, exitCode, installed: f.nvda.installed, installedVersion: f.nvda.version, running: f.nvda.running };
}

async function installAddon({ dryRun }) {
  const r = await fetch(`https://api.github.com/repos/${ADDON_REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "claude-power-tools/screenreader" }, signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`GitHub answered HTTP ${r.status} for ${ADDON_REPO}'s latest release`);
  const release = await r.json();
  const asset = (release.assets ?? []).find((a) => a.name.endsWith(".nvda-addon"));
  if (!asset) throw new Error(`${ADDON_REPO}'s latest release has no .nvda-addon file`);
  const version = String(release.tag_name).replace(/^v/, "");
  const sha256 = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? "")?.[1] ?? null;
  const plan = { version, url: asset.browser_download_url, sha256 };
  if (dryRun) return { ...plan, dryRun: true };
  if (!sha256) throw new Error("the release publishes no SHA-256 to check the download against. Install NVDA MCP from NVDA's Add-on Store instead (NVDA+N, Tools, Add-on Store)");
  const file = await download(asset.browser_download_url, path.join(home(), "downloads", asset.name));
  checkHash(file, "sha256", sha256);
  if (!gatherFacts().nvda.running) await startNvda();
  // Opening the file makes NVDA ask the owner whether to install it.
  spawn("explorer.exe", [file], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  const cfg = nvdaConfigDir();
  const done = () => existsSync(path.join(cfg, "addons", `${ADDON_ID}.pendingInstall`)) || gatherFacts().addon.version === version;
  if (!(await waitFor(done, 5 * 60_000, 2000))) return { ...plan, installed: false, note: "NVDA's install question wasn't answered within 5 minutes" };
  const restarted = gatherFacts().addon.pending ? await startNvda({ restart: true }) : null;
  return { ...plan, installed: true, restarted, addonVersion: gatherFacts().addon.version };
}

// claude may be claude.exe or an npm claude.cmd.
function runClaude(args) {
  const c = resolveCommand("claude", args);
  return execFileSync(c.file, c.args, { encoding: "utf8", timeout: 60_000, shell: c.shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

function register({ replace }) {
  const f = gatherFacts();
  const version = f.addon?.version;
  if (!/^\d+(\.\d+)*$/.test(version ?? "")) throw new Error("the NVDA MCP add-on isn't installed, so there is no version to pin the server to: run install-addon");
  if (f.mcp && !replace) return { registered: false, already: f.mcp };
  if (f.mcp) runClaude(["mcp", "remove", MCP_NAME, "-s", f.mcp.scope]);
  runClaude(["mcp", "add", "--scope", "user", MCP_NAME, "--", "uvx", `${SERVER_PACKAGE}==${version}`]);
  return { registered: true, command: `uvx ${SERVER_PACKAGE}==${version}`, note: "Sessions started before now don't see the nvda tools; restart Claude Code (or reconnect in /mcp)." };
}

export function parseApps(apps) {
  const list = String(apps ?? "").split(",").map((a) => a.trim().replace(/\.exe$/i, "").toLowerCase()).filter(Boolean);
  const bad = list.filter((a) => !/^[\w.-]+$/.test(a));
  if (bad.length) throw new Error(`not an application name: ${bad.join(", ")}`);
  return list;
}

// off: MCP clients may no longer press keys (reading still works).
async function allowKeys({ apps, off = false }) {
  const list = off ? [] : parseApps(apps);
  const f = gatherFacts();
  if (!f.nvda?.installed) throw new Error("NVDA isn't installed: run install-nvda");
  const ini = path.join(nvdaConfigDir(), "nvda.ini");
  // NVDA writes nvda.ini when it quits, so it has to be closed while the file changes.
  if (f.nvda.running) {
    await launchNvda(f, ["-q"]);
    if (!(await waitFor(() => !nvdaRunning(), 20_000))) throw new Error("NVDA didn't quit; quit it (NVDA+Q) and run allow-keys again");
    await sleep(500); // NVDA saves nvda.ini as it exits
  }
  const text = readText(ini) ?? "";
  let backup = null;
  if (text) {
    backup = `${ini}.screenreader-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    copyFileSync(ini, backup);
  }
  mkdirSync(path.dirname(ini), { recursive: true });
  writeFileSync(ini, setIniValues(text, ADDON_ID, off ? { allowControl: false } : { enabled: true, allowControl: true, allowedApps: list.join(",") }));
  const started = await startNvda();
  if (off) return { allowControl: false, backup: backup && fwd(backup), ...started };
  return { allowControl: true, allowedApps: list.length ? list : "every application", backup: backup && fwd(backup), ...started };
}

// ---- talking to the MCP server directly, so the check doesn't depend on this session ----

export function mcpClient(command, args = [], env = {}) {
  const c = resolveCommand(command, args);
  const child = spawn(c.file, c.args, { shell: c.shell, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...env } });
  const pending = new Map();
  let buf = "";
  let stderr = "";
  let exited = null;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result ?? {});
    }
  });
  child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
  const fail = (why) => { for (const p of pending.values()) p.reject(new Error(why)); pending.clear(); };
  child.on("error", (e) => { exited = e.message; fail(e.message); });
  child.on("exit", (code) => { exited = `exited with code ${code}`; fail(`the server ${exited}${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`); });
  let id = 0;
  const send = (msg) => { if (!exited) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n"); };
  return {
    request(method, params, timeoutMs = 30_000) {
      const n = ++id;
      return new Promise((resolve, reject) => {
        if (exited) return reject(new Error(`the server ${exited}`));
        const timer = setTimeout(() => { pending.delete(n); reject(new Error(`no answer to ${method} within ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
        pending.set(n, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        send({ id: n, method, params });
      });
    },
    notify: (method, params) => send({ method, ...(params ? { params } : {}) }),
    close() {
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
    },
  };
}

// Starts the registered server the way Claude Code would, lists its tools and asks NVDA for its
// status. ok: the persona has every tool it needs and NVDA lets it press keys.
export async function verify({ registration, connect = mcpClient, startupMs = 120_000 } = {}) {
  if (!registration) return { ok: false, problems: ["The nvda MCP server isn't registered with Claude Code: run register."] };
  if (registration.type !== "stdio" || !registration.command) {
    return { ok: false, problems: [`The nvda server is registered as ${registration.type}; this check runs stdio servers only.`] };
  }
  const problems = [];
  let session;
  try {
    session = connect(registration.command, registration.args, registration.env);
    // The first start of `uvx nvda-mcp==X` downloads the server, so it gets longer.
    const init = await session.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "screenreader-verify", version: "1" } }, startupMs);
    session.notify("notifications/initialized");
    const tools = ((await session.request("tools/list", {})).tools ?? []).map((t) => t.name);
    const missing = PERSONA_TOOLS.filter((t) => !tools.includes(t));
    if (missing.length) problems.push(`The server has no ${missing.join(", ")}. Update the add-on and the server together (install-addon, then register --replace).`);
    const res = await session.request("tools/call", { name: "nvda_get_status", arguments: {} });
    const text = (res.content ?? []).map((c) => c.text ?? "").join("\n").trim();
    let status = null;
    if (res.isError) problems.push(text.replace(/^Error executing tool \w+: /, ""));
    else {
      try { status = JSON.parse(text); } catch { status = { text }; }
      if (status.isControlAllowed === false) problems.push("NVDA doesn't let MCP clients press keys: run allow-keys, or tick Allow MCP clients to press keys in NVDA Settings, NVDA MCP.");
    }
    return { ok: problems.length === 0, server: init.serverInfo ?? null, tools: tools.length, missing, status, problems };
  } catch (e) {
    return { ok: false, problems: [`The nvda server didn't answer: ${e.message}`] };
  } finally {
    session?.close();
  }
}

// ---- running a test ----

export function openCommand(url, platform = process.platform) {
  if (!/^https?:\/\/[^\s"'<>`]+$/i.test(String(url ?? ""))) throw new Error("only an http:// or https:// address can be opened");
  if (platform === "win32") return { cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { cmd: "open", args: [url] };
  return { cmd: "xdg-open", args: [url] };
}

// The report and its transcript: docs/accessibility/ in a repository, otherwise the state folder.
export function reportPaths({ cwd = process.cwd(), slug, now = Date.now(), isRepo = existsSync(path.join(cwd, ".git")) } = {}) {
  const s = String(slug ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "page";
  const date = new Date(now).toISOString().slice(0, 10);
  const dir = isRepo ? path.join(cwd, "docs", "accessibility") : path.join(home(), "reports");
  const base = `${date}-${s}-screenreader`;
  return { dir: fwd(dir), report: fwd(path.join(dir, `${base}.md`)), transcript: fwd(path.join(dir, `${base}-transcript.md`)) };
}

function flag(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

async function main(argv) {
  const [cmd = "detect", ...args] = argv;
  const out = (o) => console.log(typeof o === "string" ? o : JSON.stringify(o, null, 2));
  const dryRun = args.includes("--dry-run");
  switch (cmd) {
    case "--self-test":
      return out("ok screenreader");
    case "detect": {
      const f = gatherFacts();
      return out({ ...f, next: planNext(f), warnings: warnings(f) });
    }
    case "choose": {
      const reader = String(args[0] ?? "").toLowerCase();
      if (!["nvda", "jaws"].includes(reader)) throw new Error("choose nvda or jaws");
      writeState({ ...readState(), reader, chosenAt: new Date().toISOString() });
      return out(reader === "nvda" ? "screen reader: NVDA" : "screen reader: JAWS. No MCP server can drive JAWS yet, so the persona can't run with it. NVDA is free and installs alongside JAWS: `choose nvda` switches.");
    }
    case "install-nvda":
      return out(await installNvda({ dryRun }));
    case "install-addon":
      return out(await installAddon({ dryRun }));
    case "install-uv":
      out(execFileSync("winget", ["install", "--id=astral-sh.uv", "-e", "--silent", "--accept-package-agreements", "--accept-source-agreements"], { encoding: "utf8", windowsHide: true, timeout: 600_000 }));
      return out("uv installed. Programs started from now on find it; this shell may not until it restarts.");
    case "register":
      return out(register({ replace: args.includes("--replace") }));
    case "start-nvda":
      return out(await startNvda());
    case "restart-nvda":
      return out(await startNvda({ restart: true }));
    case "allow-keys": {
      if (args.includes("--off")) return out(await allowKeys({ off: true }));
      if (!args.includes("--apps")) throw new Error('say which applications MCP clients may press keys in: --apps brave (or --apps "" for any), or --off');
      return out(await allowKeys({ apps: flag(args, "--apps", "") }));
    }
    case "verify": {
      const r = await verify({ registration: gatherFacts().mcp });
      if (r.ok) writeState({ ...readState(), reader: readState().reader ?? "nvda", verifiedAt: new Date().toISOString() });
      out(r);
      return r.ok ? 0 : 1;
    }
    case "open": {
      const url = args.find((a) => !a.startsWith("--"));
      const c = openCommand(url);
      if (!dryRun) spawn(c.cmd, c.args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
      return out({ opened: url, ...(dryRun ? { dryRun: true, ...c } : {}) });
    }
    case "paths":
      return out(reportPaths({ cwd: flag(args, "--cwd", process.cwd()), slug: flag(args, "--slug", "page") }));
    default:
      console.error(`unknown command: ${cmd}`);
      return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SCRIPT)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code ?? 0; }, (e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  });
}
