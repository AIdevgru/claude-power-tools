#!/usr/bin/env node
// Usage watcher for /usage-handoff. Reads the account's Claude usage windows (the numbers `/usage`
// shows), decides whether the fleet should write handoffs, and restarts the work once the limit
// resets.
//
//   check [--threshold N]        JSON: usage, the action to take (watch | handoff | wait | resume |
//                                unknown) and when to check next. N defaults to 95 (percent).
//   mark-handoff --resume-at ISO --session NAME [--cwd DIR] [--no-waker]
//                                Record that handoffs were requested; starts the background waker.
//   claim-resume --by NAME       Exit 0 if NAME may run the resume now, 3 if another session has it.
//   pending                      JSON list of handoff files whose Status is still pending.
//   mark-messaged FILE...        Record that the live owner of these handoffs was told to resume.
//   mark-resumed FILE --by NAME  Set a handoff's Status line to "resumed by NAME".
//   finish-resume                Back to watching.
//   launch FILE [--dry-run]      Open a new terminal running `claude` that resumes from FILE.
//   wake                         (background) sleep until the reset, then start a resume session.
//   hook on|off|status           Switch the hook below on or off for every session (default on).
//   status | reset | paths   reset (and finish-resume) also remove old resume claims.
//   rehearse                     Run the whole cycle in a scratch folder with made-up usage; exit 1 on a failure.
//   statusline                   One line for Claude Code's status line, from the cached reading.
//
//   --hook                       Hook mode (UserPromptSubmit, PostToolUse): reads hook JSON on stdin.
//                                Reads usage from a shared cache (refreshed every 1-10 minutes,
//                                sooner as usage climbs). At the threshold it creates this
//                                session's handoff file, tells the session (or subagent) once per
//                                window to wrap up, and starts the waker. Silent otherwise.
//   --self-test                  Prints "ok" (for the hook doctor).
//
// Configuration (all optional):
//   USAGE_HANDOFF_HOOK     "off" turns the hook off, whatever config.json says
//   USAGE_HANDOFF_HOME     state, handoffs and logs (default: ~/.claude/usage-handoff)
//   USAGE_HANDOFF_CMD      a command that prints usage JSON in the /api/oauth/usage shape
//   USAGE_HANDOFF_FIXTURE  a JSON file to read instead (tests)
//   CLAUDE_CONFIG_DIR      where Claude Code keeps .credentials.json (default: ~/.claude)
//
// The usage endpoint is the one Claude Code's /usage reads. It isn't a documented API, so every
// failure is reported as action "unknown" instead of guessed.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, appendFileSync, openSync, closeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_THRESHOLD = 95;
export const MIN_WAKE_S = 60;
export const MAX_WAKE_S = 3600; // ScheduleWakeup's ceiling
export const RESUME_GRACE_S = 60; // the watcher's own wakeup lands this long after the reset
export const WAKER_GRACE_S = 180; // the background waker waits longer, so a live watcher wins
export const STALE_CLAIM_MS = 30 * 60_000;
export const MESSAGED_STALE_MS = 15 * 60_000;
const SCRIPT = fileURLToPath(import.meta.url);
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export const home = () => process.env.USAGE_HANDOFF_HOME || path.join(homedir(), ".claude", "usage-handoff");
export const handoffDir = () => path.join(home(), "handoffs");
const stateFile = () => path.join(home(), "state.json");
const logFile = () => path.join(home(), "waker.log");
const fwd = (p) => p.replace(/\\/g, "/");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

export function readState() {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8"));
  } catch {
    return { phase: "watching" };
  }
}

export function writeState(state) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify(state, null, 2) + "\n");
}

// Every usage window in the response that carries a percentage and a reset time.
export function parseWindows(json) {
  const out = [];
  for (const [name, w] of Object.entries(json ?? {})) {
    if (name === "extra_usage" || !w || typeof w !== "object" || Array.isArray(w)) continue;
    if (typeof w.utilization !== "number") continue;
    const resetsAt = w.resets_at ? Date.parse(w.resets_at) : NaN;
    out.push({ name, pct: w.utilization, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null });
  }
  return out.sort((a, b) => b.pct - a.pct);
}

// How long to wait before the next check while usage is below the threshold.
export function pace(pct, threshold = DEFAULT_THRESHOLD) {
  if (pct >= threshold - 5) return 120;
  if (pct >= threshold - 10) return 300;
  if (pct >= threshold - 20) return 900;
  if (pct >= threshold - 45) return 1800;
  return MAX_WAKE_S;
}

const clampWake = (s) => Math.min(MAX_WAKE_S, Math.max(MIN_WAKE_S, Math.ceil(s)));

// The heart of the skill: what to do now, given the usage reading (null when it failed).
export function decide({ windows, state = {}, now = Date.now(), threshold = DEFAULT_THRESHOLD }) {
  const worst = windows?.[0] ?? null;
  const hot = (windows ?? []).filter((w) => w.pct >= threshold);
  const hotReset = hot.length ? Math.max(...hot.map((w) => w.resetsAt ?? now + MAX_WAKE_S * 1000)) : null;
  const base = { pct: worst?.pct ?? null, window: worst?.name ?? null, resetsAt: worst?.resetsAt ? iso(worst.resetsAt) : null, hot: hot.map((w) => w.name), threshold };
  const phase = state.phase ?? "watching";

  if (phase === "watching") {
    if (!windows) return { ...base, action: "unknown", nextCheckSeconds: 900 };
    if (hot.length) return { ...base, action: "handoff", resumeAt: iso(hotReset), nextCheckSeconds: clampWake((hotReset - now) / 1000 + RESUME_GRACE_S) };
    return { ...base, action: "watch", nextCheckSeconds: pace(worst?.pct ?? 0, threshold) };
  }

  // handoff or resuming: wait for the reset, then resume.
  let resumeAt = Date.parse(state.resumeAt);
  if (!Number.isFinite(resumeAt)) resumeAt = now;
  if (hotReset && hotReset > resumeAt) resumeAt = hotReset; // another window filled up meanwhile
  const out = { ...base, resumeAt: iso(resumeAt) };
  if (now < resumeAt) return { ...out, action: "wait", nextCheckSeconds: clampWake((resumeAt - now) / 1000 + RESUME_GRACE_S) };
  if (hot.length) return { ...out, action: "wait", nextCheckSeconds: 300 }; // reset passed but the reading hasn't caught up
  return { ...out, action: "resume", nextCheckSeconds: MIN_WAKE_S };
}

function credentials() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
  const file = path.join(dir, ".credentials.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).claudeAiOauth;
  if (process.platform === "darwin") {
    const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", timeout: 10_000 });
    return JSON.parse(raw).claudeAiOauth;
  }
  throw new Error(`no Claude Code login found at ${fwd(file)}`);
}

// Returns the raw usage JSON, or throws with a one-line reason.
export async function fetchUsage() {
  if (process.env.USAGE_HANDOFF_FIXTURE) return JSON.parse(readFileSync(process.env.USAGE_HANDOFF_FIXTURE, "utf8"));
  if (process.env.USAGE_HANDOFF_CMD) {
    return JSON.parse(execFileSync(process.env.USAGE_HANDOFF_CMD, { encoding: "utf8", shell: true, timeout: 30_000 }));
  }
  const cred = credentials();
  if (!cred?.accessToken) throw new Error("not logged in with a Claude subscription (no OAuth token)");
  if (cred.expiresAt && cred.expiresAt < Date.now()) throw new Error("the saved login token has expired; any running Claude Code session renews it");
  // The token only ever goes to the service that issued it.
  const r = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${cred.accessToken}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-power-tools/usage-handoff" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`usage endpoint answered HTTP ${r.status}`);
  return r.json();
}

async function readWindows() {
  try {
    return { windows: parseWindows(await fetchUsage()) };
  } catch (e) {
    return { windows: null, error: String(e.message || e).split("\n")[0] };
  }
}

// ---- shared usage cache, so many sessions' hooks cost one request per minute at most ----

const cacheFile = () => path.join(home(), "usage-cache.json");
const configFile = () => path.join(home(), "config.json");

// How long a cached reading stays good: a minute near the threshold, ten when far below it.
export function cacheTtlMs(pct, threshold = DEFAULT_THRESHOLD) {
  if (pct == null) return 10 * 60_000; // the last read failed: don't hammer the endpoint
  if (pct >= threshold - 10) return 60_000;
  if (pct >= threshold - 20) return 5 * 60_000;
  return 10 * 60_000;
}

// force: read now (the /usage-handoff tick), but still share the reading with the hooks.
export async function cachedWindows(now = Date.now(), threshold = DEFAULT_THRESHOLD, read = readWindows, force = false) {
  let cache = {};
  try { cache = JSON.parse(readFileSync(cacheFile(), "utf8")); } catch {}
  const pct = cache.windows?.[0]?.pct ?? null;
  const fresh = cache.at && now - cache.at < cacheTtlMs(pct, threshold);
  const leased = cache.leaseAt && now - cache.leaseAt < 30_000; // another session is reading right now
  if (!force && (fresh || leased)) return { windows: cache.windows ?? null, error: cache.error, cached: true };
  mkdirSync(home(), { recursive: true });
  writeFileSync(cacheFile(), JSON.stringify({ ...cache, leaseAt: now }));
  const r = await read();
  writeFileSync(cacheFile(), JSON.stringify({ at: now, windows: r.windows, ...(r.error ? { error: r.error } : {}) }));
  return { ...r, cached: false };
}

export function hookEnabled(env = process.env) {
  if (/^(off|0|false|no)$/i.test(env.USAGE_HANDOFF_HOOK ?? "")) return false;
  try { return JSON.parse(readFileSync(configFile(), "utf8")).hook !== "off"; } catch { return true; }
}

function setHook(value) {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(configFile(), "utf8")); } catch {}
  mkdirSync(home(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify({ ...cfg, hook: value }, null, 2) + "\n");
}

// ---- open sessions, from Claude Code's own session registry (~/.claude/sessions/<pid>.json) ----

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");

// Session id -> pid for every Claude Code session whose process is still running. Empty if the
// registry isn't there (it's Claude Code's internal format, so treat it as a hint).
export function openSessions(dir = path.join(claudeDir(), "sessions"), isAlive = alive) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    try {
      const s = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      if (s.sessionId && s.pid && isAlive(s.pid)) out.set(s.sessionId, s.pid);
    } catch {}
  }
  return out;
}

// True if Claude Code still has the conversation, so `claude --resume <id>` can reopen it.
export function hasTranscript(sessionId, dir = path.join(claudeDir(), "projects")) {
  if (!sessionId || !/^[\w-]+$/.test(sessionId) || !existsSync(dir)) return false;
  return readdirSync(dir).some((p) => existsSync(path.join(dir, p, `${sessionId}.jsonl`)));
}

// Handoff files: Markdown with "Key: value" header lines.
export function parseHandoff(text) {
  const out = {};
  for (const line of text.split(/\r?\n/).slice(0, 30)) {
    const m = /^(Status|Session|SessionId|Cwd|Branch|PR|Written|Resets):\s*(.*)$/.exec(line.trim());
    // "Resets: <UTC> (<local>)": keep the machine-readable part.
    if (!m || m[1].toLowerCase() in out) continue;
    out[m[1].toLowerCase()] = (m[1] === "Resets" ? m[2].replace(/\s*\([^)]*\)\s*$/, "") : m[2]).trim();
  }
  return out;
}

export function listHandoffs(dir = handoffDir()) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => {
    const file = path.join(dir, f);
    return { file: fwd(file), name: f.slice(0, -3), mtime: statSync(file).mtimeMs, ...parseHandoff(readFileSync(file, "utf8")) };
  });
}

export const isPending = (h) => /^pending\b/i.test(h.status ?? "");

export function markResumed(file, by, now = Date.now()) {
  const text = readFileSync(file, "utf8");
  const line = `Status: resumed by ${by} at ${iso(now)}`;
  const next = /^Status:.*$/m.test(text) ? text.replace(/^Status:.*$/m, () => line) : `${line}\n${text}`;
  writeFileSync(file, next);
}

// Handoffs whose live owner was told to resume a while ago but never picked them up.
export function stalePending(state, handoffs, now = Date.now()) {
  const messaged = state.messaged ?? {};
  return handoffs.filter((h) => isPending(h) && messaged[h.file] && now - messaged[h.file] > MESSAGED_STALE_MS).map((h) => h.file);
}

// One claim per reset, so the watcher and the background waker never both resume. The waker's
// claim hands over to the session it starts; any claim older than 30 minutes can be taken.
export function claimResume(by, state = readState(), now = Date.now()) {
  mkdirSync(home(), { recursive: true });
  const key = String(state.resumeAt ?? "now").replace(/[^\w-]/g, "");
  const lock = path.join(home(), `resume-${key}.lock`);
  const body = JSON.stringify({ by, at: now });
  try {
    closeSync(openSync(lock, "wx"));
    writeFileSync(lock, body);
    return { claimed: true, by };
  } catch {
    let held = {};
    try { held = JSON.parse(readFileSync(lock, "utf8")); } catch {}
    // A waker never re-takes a waker's claim: that claim means a resume session was already started.
    const sameSession = held.by === by && by !== "waker";
    const canTake = sameSession || (held.by === "waker" && by !== "waker") || !held.at || now - held.at > STALE_CLAIM_MS;
    if (!canTake) return { claimed: false, by: held.by };
    writeFileSync(lock, body);
    return { claimed: true, by, tookOverFrom: held.by };
  }
}

// Text that survives cmd.exe, wt and shell quoting: no quotes, separators or redirections.
const safe = (s) => s.replace(/["`$;&|<>^%!]/g, "'").replace(/\s+/g, " ").trim();

export const resumePrompt = (file) => safe(`Resume from the usage handoff at ${fwd(file)}. Read it first, set its Status line to resumed by plus your session name, run git status in its Cwd, then carry on with its Next steps. If its sections are still empty, the session ran out of usage before writing them: work out where it stopped from the conversation and git status. Restart any subagent work that was in flight.`);
export const RESUMER_PROMPT = safe("Claude usage has reset. Run the usage-handoff skill with the argument resume to restart the sessions that wrote handoffs.");

// What the hidden resume session may use: the skill, its script, and the session tools.
export const RESUMER_TOOLS = "Skill,ToolSearch,ListAgents,SendMessage,Read,Bash(node:*),PowerShell(node:*)";

// The full path of the claude executable. Starting it by name isn't reliable: cmd.exe misses
// entries late in a long PATH, and a waker started from a hook may not have the user's PATH.
// USAGE_HANDOFF_CLAUDE overrides.
export function resolveClaude({ env = process.env, platform = process.platform, exists = existsSync, which = whichAll } = {}) {
  if (env.USAGE_HANDOFF_CLAUDE) return env.USAGE_HANDOFF_CLAUDE;
  const found = which("claude");
  const pick = platform === "win32" ? found.find((p) => /\.exe$/i.test(p)) ?? found.find((p) => /\.(cmd|bat)$/i.test(p)) : found[0];
  if (pick) return pick;
  const home = env.USERPROFILE || env.HOME || homedir();
  const known = platform === "win32"
    ? [path.join(home, ".local", "bin", "claude.exe"), path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "npm", "claude.cmd")]
    : [path.join(home, ".local", "bin", "claude"), path.join(home, ".claude", "local", "claude"), "/usr/local/bin/claude", "/opt/homebrew/bin/claude"];
  return known.find((p) => exists(p)) ?? "claude";
}

function whichAll(name) {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const isShim = (p) => /\.(cmd|bat)$/i.test(p);

// The hidden resume session: claude -p, no window, output to resumer.log. It messages the open
// sessions (they resume in their own windows) and opens windows only for sessions that closed.
export function resumerCommand({ platform = process.platform, prompt = RESUMER_PROMPT, claude = resolveClaude({ platform }) } = {}) {
  const args = ["-p", safe(prompt), "--allowedTools", RESUMER_TOOLS, "--max-turns", "40"];
  // A .cmd shim (npm installs) only runs through cmd.exe; `call` keeps cmd from eating the quotes.
  if (platform === "win32" && isShim(claude)) {
    return { cmd: "cmd.exe", args: [`/d /c call "${claude}" -p "${args[1]}" --allowedTools "${RESUMER_TOOLS}" --max-turns 40`], verbatim: true };
  }
  return { cmd: claude, args };
}

// The command that opens a new terminal running claude in cwd, or null if none is known. With
// resumeId it reopens that conversation (claude --resume <id> <prompt>) instead of a fresh one.
// The window closes by itself when that claude exits.
export function launchCommand({ platform = process.platform, cwd, prompt, resumeId = null, has = onPath, claude = resolveClaude({ platform }) }) {
  const p = safe(prompt);
  const id = resumeId && /^[\w-]+$/.test(resumeId) ? resumeId : null;
  const resume = id ? `--resume ${id} ` : "";
  if (platform === "win32") {
    const dir = cwd.replace(/\//g, "\\");
    if (has("wt.exe") || has("wt")) return { cmd: "wt.exe", args: ["-w", "new", "-d", dir, "cmd", "/c", "call", claude, ...(id ? ["--resume", id] : []), p] };
    return { cmd: "cmd.exe", args: [`/c start "claude resume" /D "${dir}" cmd /c call "${claude}" ${resume}"${p}"`], verbatim: true };
  }
  const sh = `cd '${cwd.replace(/'/g, "'\\''")}' && '${claude.replace(/'/g, "'\\''")}' ${resume}'${p}'`;
  if (platform === "darwin") {
    return { cmd: "osascript", args: ["-e", `tell application "Terminal" to do script "${sh.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`] };
  }
  for (const [term, flag] of [["x-terminal-emulator", "-e"], ["gnome-terminal", "--"], ["konsole", "-e"], ["xterm", "-e"]]) {
    if (has(term)) return { cmd: term, args: [flag, "bash", "-lc", sh] };
  }
  return null;
}

function onPath(name) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function launch(cwd, prompt, dryRun, resumeId = null) {
  if (!cwd || !existsSync(cwd)) throw new Error(`folder not found: ${cwd}`);
  const c = launchCommand({ cwd, prompt, resumeId });
  const dry = dryRun || process.env.USAGE_HANDOFF_DRY_LAUNCH; // the env var is for tests
  if (!c) {
    const manual = `cd "${cwd}" && claude ${resumeId ? `--resume ${resumeId} ` : ""}"${safe(prompt)}"`;
    if (dry) return { cmd: null, args: [], manual };
    throw new Error(`no terminal found; run this yourself: ${manual}`);
  }
  if (dry) return c;
  // windowsHide hides only the short-lived launcher; `start` opens the one visible window.
  spawn(c.cmd, c.args, { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: !!c.verbatim }).unref();
  return c;
}

const resumerLog = () => path.join(home(), "resumer.log");

// Starts the hidden resume session in cwd. No window; its output goes to resumer.log.
function startResumer(cwd) {
  const c = resumerCommand();
  if (process.env.USAGE_HANDOFF_DRY_LAUNCH) return c; // tests
  mkdirSync(home(), { recursive: true });
  appendFileSync(resumerLog(), `\n--- ${iso(Date.now())} resume session in ${fwd(cwd)}\n`);
  const fd = openSync(resumerLog(), "a");
  spawn(c.cmd, c.args, { cwd, detached: true, windowsHide: true, windowsVerbatimArguments: !!c.verbatim, stdio: ["ignore", fd, fd] }).unref();
  closeSync(fd);
  return c;
}

function log(msg) {
  mkdirSync(home(), { recursive: true });
  appendFileSync(logFile(), `${iso(Date.now())} ${msg}\n`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export function armWaker(state) {
  if (state.waker?.pid && state.waker.resumeAt === state.resumeAt && alive(state.waker.pid)) return state.waker;
  const child = spawn(process.execPath, [SCRIPT, "wake"], { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
  child.unref();
  return { pid: child.pid, resumeAt: state.resumeAt, armedAt: iso(Date.now()) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// USAGE_HANDOFF_GRACE_S shortens the wait after the reset (rehearse uses 1 second).
const graceS = () => {
  const v = process.env.USAGE_HANDOFF_GRACE_S;
  return v && Number(v) >= 0 ? Number(v) : WAKER_GRACE_S;
};

// Resume claims from earlier resets. finish-resume and reset remove them.
export function staleLocks(state = readState(), dir = home()) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => /^resume-.*\.lock$/.test(n)); } catch {}
  const current = `resume-${String(state.resumeAt ?? "now").replace(/[^\w-]/g, "")}.lock`;
  return names.filter((n) => state.phase === "watching" || n !== current).map((n) => path.join(dir, n));
}
const clearLocks = (state) => { for (const f of staleLocks(state)) rmSync(f, { force: true }); };

// Background process: wait for the reset, then start one Claude session that runs the resume.
async function wake() {
  log(`waker ${process.pid} started`);
  await sleep(5000); // let mark-handoff save this process's pid first
  for (let i = 0; i < 10_000; i++) {
    const state = readState();
    if (state.phase === "watching" || state.waker?.pid !== process.pid) return log(`waker ${process.pid}: not needed any more, exiting`);
    const resumeAt = Date.parse(state.resumeAt) || Date.now();
    const wait = resumeAt + graceS() * 1000 - Date.now();
    if (wait > 0) {
      await sleep(Math.min(wait, 10 * 60_000));
      continue;
    }
    const { windows } = await readWindows();
    const d = decide({ windows, state, threshold: state.threshold ?? DEFAULT_THRESHOLD });
    if (d.action === "wait") {
      if (d.resumeAt !== state.resumeAt) writeState({ ...state, resumeAt: d.resumeAt });
      await sleep(5 * 60_000);
      continue;
    }
    const pending = listHandoffs().filter(isPending);
    if (!pending.length) {
      writeState({ ...readState(), phase: "watching", waker: null, lastResumeAt: iso(Date.now()) });
      return log(`waker ${process.pid}: usage reset, no pending handoffs, nothing to start`);
    }
    const claim = claimResume("waker", state);
    if (claim.claimed) writeState({ ...readState(), phase: "resuming", resumingSince: iso(Date.now()) });
    else {
      await sleep(5 * 60_000); // a session is resuming; check again in case it stops halfway
      continue;
    }
    try {
      const cwd = state.cwd && existsSync(state.cwd) ? state.cwd : homedir();
      const c = startResumer(cwd);
      log(`waker ${process.pid}: started a hidden resume session for ${pending.length} handoff(s) in ${fwd(cwd)}: ${c.cmd} ${c.args.join(" ")}`);
    } catch (e) {
      log(`waker ${process.pid}: could not start the resume session: ${e.message}`);
    }
    return;
  }
}

// ---- hook mode ----

const notifiedFile = () => path.join(home(), "notified.json");
const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } };
// The owner reads times in their own zone: "00:10 EST", with the date when it isn't today.
export function localTime(ms, now = Date.now()) {
  const t = typeof ms === "string" ? Date.parse(ms) : ms;
  if (!Number.isFinite(t)) return null;
  try {
    const d = new Date(t);
    const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" });
    if (d.toDateString() === new Date(now).toDateString()) return time;
    return `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} ${time}`;
  } catch { return iso(t); }
}

export const handoffSlug = (cwd, sessionId) =>
  `${path.basename(cwd || "session").replace(/[^\w.-]/g, "-")}-${String(sessionId || "unknown").replace(/[^\w-]/g, "").slice(0, 8)}`;

export function skeleton({ sessionId, cwd, branch = "-", resumeAt, now = Date.now() }) {
  return [
    "# Handoff", "Status: pending", "Session: (fill in your session name)", `SessionId: ${sessionId}`, `Cwd: ${fwd(cwd)}`,
    `Branch: ${branch || "-"}`, "PR: -", `Written: ${iso(now)}`, `Resets: ${iso(resumeAt)} (${localTime(resumeAt, now)})`, "",
    "## Goal", "", "## Done", "", "## In flight (one entry per subagent)", "", "## Next steps", "", "## Watch out for", "",
  ].join("\n");
}

// What one hook call should do, without side effects: null to stay quiet, or who to tell what.
// Each session and each subagent hears it once per usage window.
export function hookPlan({ input, windows, threshold = DEFAULT_THRESHOLD, notified = {}, now = Date.now() }) {
  // A reading whose reset time has passed is stale: the window is already empty again.
  const hot = (windows ?? []).filter((w) => w.pct >= threshold && (w.resetsAt == null || w.resetsAt > now));
  if (!hot.length || !input?.session_id) return null;
  const resumeAt = Math.max(...hot.map((w) => w.resetsAt ?? now + MAX_WAKE_S * 1000));
  const key = `${input.session_id}:${input.agent_id || "main"}`;
  if (notified[key] && Date.parse(notified[key]) > now) return null;
  return { key, resumeAt, pct: hot[0].pct, window: hot[0].name, subagent: Boolean(input.agent_id) };
}

export function hookMessage(plan, file) {
  const head = `usage-handoff: Claude usage is at ${plan.pct}% of the ${plan.window.replace(/_/g, "-")} limit (resets ${localTime(plan.resumeAt)}).`;
  if (plan.subagent) {
    return `${head} Stop at the next safe point: finish or undo the step you're on, start nothing new, and end with a short report for your parent session: your goal, what's done, what's left, your worktree and branch, and any uncommitted changes.`;
  }
  return [
    `${head} Wrap up before it runs out:`,
    "1. Stop starting new work, and don't launch new subagents.",
    "2. Tell each subagent you have running (SendMessage to its id) to stop at a safe point and report its goal, what's done, what's left, its worktree and branch, and any uncommitted changes.",
    "3. Save uncommitted work as a WIP commit on your own branch if the repo's rules allow (never git stash).",
    `4. Fill in your handoff at ${fwd(file)}: Read it, put your session name on the Session line, and write each section so a fresh session could carry on.`,
    `5. End your turn. After the reset (${localTime(plan.resumeAt)}) this session is reopened or messaged and told to resume from that file. When you tell the owner a time, use their local time as written here, not UTC.`,
    "The owner can turn this off with /usage-handoff off.",
  ].join("\n");
}

function ensureSkeleton(input, resumeAt, now) {
  const file = path.join(handoffDir(), `${handoffSlug(input.cwd, input.session_id)}.md`);
  if (existsSync(file) && isPending(parseHandoff(readFileSync(file, "utf8")))) return file;
  let branch = "-";
  try {
    branch = execFileSync("git", ["-C", input.cwd, "branch", "--show-current"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim() || "-";
  } catch {}
  mkdirSync(handoffDir(), { recursive: true });
  writeFileSync(file, skeleton({ sessionId: input.session_id, cwd: input.cwd || process.cwd(), branch, resumeAt, now }));
  return file;
}

// The first session to see the threshold records the reset and starts the waker; later ones only
// make sure a waker is still running.
function ensureArmed(resumeAt, cwd, now) {
  const st = readState();
  const cur = Date.parse(st.resumeAt);
  const next = st.phase === "watching" || !Number.isFinite(cur) || cur < resumeAt
    ? { ...st, phase: "handoff", resumeAt: iso(resumeAt), cwd: fwd(cwd || process.cwd()), requestedAt: iso(now), messaged: {} }
    : st;
  next.waker = armWaker(next);
  writeState(next);
}

export async function runHook(raw, now = Date.now()) {
  if (!hookEnabled()) return null;
  const input = JSON.parse(raw || "{}");
  const event = input.hook_event_name;
  if (event !== "UserPromptSubmit" && event !== "PostToolUse") return null;
  const threshold = readState().threshold ?? DEFAULT_THRESHOLD;
  const { windows } = await cachedWindows(now, threshold);
  const notified = readJson(notifiedFile(), {});
  const plan = hookPlan({ input, windows, threshold, notified, now });
  if (!plan) {
    // A restart is due but its waker is gone (the machine rebooted, say): start one, and it
    // resumes right away.
    const st = readState();
    // Only while waiting for the reset; once a resume has started it owns the restart, unless it
    // has been stuck for longer than a claim lasts.
    const stuck = st.phase === "resuming" && now - (Date.parse(st.resumingSince) || now) > STALE_CLAIM_MS;
    if ((st.phase === "handoff" || stuck) && Date.parse(st.resumeAt) < now && !(st.waker?.pid && alive(st.waker.pid))) {
      writeState({ ...st, waker: armWaker({ ...st, waker: null }) });
    }
    return null;
  }
  const file = plan.subagent ? null : ensureSkeleton(input, plan.resumeAt, now);
  for (const [k, v] of Object.entries(notified)) if (Date.parse(v) < now - 24 * 3600_000) delete notified[k];
  notified[plan.key] = iso(plan.resumeAt);
  writeFileSync(notifiedFile(), JSON.stringify(notified, null, 2));
  ensureArmed(plan.resumeAt, input.cwd, now);
  return { hookSpecificOutput: { hookEventName: event, additionalContext: hookMessage(plan, file) } };
}

// ---- status line ----

const WINDOW_LABELS = { five_hour: "5h", seven_day: "week" };

// localTime, shorter for the status line: "00:10 EST" today, "Sun 19:00 EST" within the week.
export function shortLocalTime(ms, now = Date.now()) {
  const full = localTime(ms, now);
  if (!full || ms - now >= 7 * 86_400_000 || new Date(ms).toDateString() === new Date(now).toDateString()) return full;
  try {
    return `${new Date(ms).toLocaleDateString("en-US", { weekday: "short" })} ${full.split(" ").slice(-2).join(" ")}`;
  } catch { return full; }
}

// One short line for Claude Code's status line, from the shared cache only (no API call):
// "5h 64% (resets 00:10 EST) · week 49% (resets Sun 19:00 EST)". Each window carries its own
// reset, so it's clear which one resets when.
export function statusText({ cache, state = {}, now = Date.now() }) {
  const windows = (cache?.windows ?? []).filter((w) => typeof w.pct === "number");
  if (!windows.length) return "usage: no reading yet";
  const parts = windows.map((w) => {
    const label = `${WINDOW_LABELS[w.name] ?? w.name.replace(/_/g, "-")} ${Math.round(w.pct)}%`;
    return w.resetsAt && w.resetsAt > now ? `${label} (resets ${shortLocalTime(w.resetsAt, now)})` : label;
  });
  if (state.phase === "handoff" && state.resumeAt) parts.push(`handing off, back ${shortLocalTime(Date.parse(state.resumeAt), now)}`);
  else if (state.phase === "resuming") parts.push("resuming");
  const ageMin = cache.at ? Math.round((now - cache.at) / 60_000) : null;
  if (ageMin != null && ageMin >= 15) parts.push(`${ageMin} min old`);
  return parts.join(" · ");
}

// ---- rehearse ----

// Runs the whole cycle in a scratch folder with made-up usage: 96% → the hook's note, handoff and
// waker → the reset → the hidden resume (not really started) → back to watching. Nothing real is
// touched; at the end it lists leftovers in the real state folder.
async function rehearse() {
  const scratch = mkdtempSync(path.join(tmpdir(), "usage-rehearse-"));
  const work = path.join(scratch, "work");
  const fixture = path.join(scratch, "usage.json");
  const rhome = path.join(scratch, "home");
  mkdirSync(work, { recursive: true });
  const env = {
    ...process.env, USAGE_HANDOFF_HOME: rhome, USAGE_HANDOFF_FIXTURE: fixture, USAGE_HANDOFF_DRY_LAUNCH: "1",
    USAGE_HANDOFF_GRACE_S: "1", CLAUDE_CONFIG_DIR: path.join(scratch, "claude"),
  };
  delete env.USAGE_HANDOFF_HOOK;
  delete env.USAGE_HANDOFF_CMD;
  const run = (args, input = "") => execFileSync(process.execPath, [SCRIPT, ...args], { env, input, encoding: "utf8", cwd: work });
  const hook = (extra) => run(["--hook"], JSON.stringify({ hook_event_name: "PostToolUse", session_id: "rehearse-aaaa1111", cwd: work, tool_name: "Bash", ...extra }));
  const read = (name) => { try { return readFileSync(path.join(rhome, name), "utf8"); } catch { return ""; } };
  const state = () => { try { return JSON.parse(read("state.json")); } catch { return {}; } };
  const wakers = () => (read("waker.log").match(/waker \d+ started/g) ?? []).length;
  const results = [];
  const step = (ok, text) => { results.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${text}`); };
  const usage = (pct, resetAt) => writeFileSync(fixture, JSON.stringify({
    five_hour: { utilization: pct, resets_at: iso(resetAt) }, seven_day: { utilization: 40, resets_at: iso(resetAt + 3 * 86_400_000) },
  }));

  try {
    const resetAt = Date.now() + 4000;
    usage(96, resetAt);
    const note = hook();
    step(/Wrap up before it runs out/.test(note), "at 96% the hook tells the session to wrap up");
    step(note.includes(`resets ${localTime(resetAt)}`), `the note gives the reset in local time (${localTime(resetAt)})`);
    const hdir = path.join(rhome, "handoffs");
    const handoffs = existsSync(hdir) ? readdirSync(hdir) : [];
    const text = handoffs[0] ? readFileSync(path.join(hdir, handoffs[0]), "utf8") : "";
    step(handoffs.length === 1 && /^Status: pending$/m.test(text), "the hook wrote one pending handoff");
    step(/^Resets: \S+Z \(.+\)$/m.test(text), "the handoff's Resets line carries the local time");
    step(hook() === "", "the same session isn't told twice");
    step(/report for your parent session/.test(hook({ agent_id: "sub-1" })), "a subagent gets its own short note");
    step(state().phase === "handoff" && !!state().waker?.pid, "the state says handoff and a waker is armed");

    usage(5, resetAt + 5 * 3_600_000); // after the reset the window is nearly empty
    const until = Date.now() + 30_000;
    while (Date.now() < until && !/hidden resume session|could not start/.test(read("waker.log"))) await sleep(500);
    const log = read("waker.log");
    step(/started a hidden resume session for 1 handoff\(s\)/.test(log), "after the reset the waker starts one hidden resume session");
    step(state().phase === "resuming", "the state says resuming");
    hook({ session_id: "rehearse-bbbb2222" });
    await sleep(1500);
    step(wakers() === 1, `only one waker ran (${wakers()})`);
    run(["finish-resume"]);
    step(state().phase === "watching" && !readdirSync(rhome).some((n) => n.endsWith(".lock")), "finish-resume goes back to watching and removes the claim");
  } catch (e) {
    step(false, `the rehearsal stopped: ${e.message.split("\n")[0]}`);
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch {}
  }

  // Leftovers in the real state folder.
  const real = readState();
  const locks = staleLocks(real);
  if (locks.length) console.log(`note ${locks.length} old resume claim(s) in ${fwd(home())}; the next finish-resume or reset removes them`);
  if (real.phase === "handoff" && real.waker?.pid && !alive(real.waker.pid)) console.log("note the real waker isn't running; the next hook call after the reset starts one");
  const passed = results.every(Boolean);
  console.log(passed ? "rehearsal passed" : "rehearsal FAILED");
  return passed ? 0 : 1;
}

function flag(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

async function main(argv) {
  const [cmd = "check", ...args] = argv;
  const out = (o) => console.log(typeof o === "string" ? o : JSON.stringify(o, null, 2));
  if (cmd === "--self-test") return out("ok usage-handoff");
  if (cmd === "--hook") {
    // Fails open: any error leaves the session alone.
    try {
      const r = await runHook(readFileSync(0, "utf8"));
      if (r) out(r);
    } catch {}
    return 0;
  }
  const state = readState();

  switch (cmd) {
    case "check": {
      const threshold = Number(flag(args, "--threshold", state.threshold ?? DEFAULT_THRESHOLD));
      if (state.threshold !== threshold) writeState({ ...state, threshold });
      const { windows, error } = await cachedWindows(Date.now(), threshold, readWindows, true);
      const d = decide({ windows, state, threshold });
      const handoffs = listHandoffs();
      return out({
        ...d,
        ...(d.resumeAt ? { resumeAtLocal: localTime(d.resumeAt) } : {}),
        phase: state.phase ?? "watching",
        ...(error ? { error } : {}),
        windows: (windows ?? []).map((w) => ({ name: w.name, pct: w.pct, resetsAt: w.resetsAt ? iso(w.resetsAt) : null, resetsAtLocal: w.resetsAt ? localTime(w.resetsAt) : null })),
        handoffDir: fwd(handoffDir()),
        pending: handoffs.filter(isPending).length,
        stalePending: stalePending(state, handoffs),
        waker: state.waker ? { ...state.waker, alive: alive(state.waker.pid) } : null,
      });
    }
    case "mark-handoff": {
      const next = {
        ...state,
        phase: "handoff",
        resumeAt: flag(args, "--resume-at", state.resumeAt),
        watcher: flag(args, "--session", state.watcher),
        cwd: fwd(path.resolve(flag(args, "--cwd", process.cwd()))),
        requestedAt: iso(Date.now()),
        messaged: {},
      };
      if (!args.includes("--no-waker")) next.waker = armWaker(next);
      writeState(next);
      return out({ phase: next.phase, resumeAt: next.resumeAt, resumeAtLocal: localTime(next.resumeAt), waker: next.waker ?? null, handoffDir: fwd(handoffDir()) });
    }
    case "claim-resume": {
      const r = claimResume(flag(args, "--by", "unknown"), state);
      if (r.claimed) writeState({ ...state, phase: "resuming", resumingSince: iso(Date.now()) });
      out(r);
      return r.claimed ? 0 : 3;
    }
    case "pending": {
      // open: the session is still running (message it); canReopen: claude --resume can bring it back.
      const open = openSessions();
      return out(listHandoffs().filter(isPending).map((h) => ({
        ...h,
        open: h.sessionid ? open.has(h.sessionid) : null,
        canReopen: hasTranscript(h.sessionid),
      })));
    }
    case "hook": {
      if (args[0] === "on" || args[0] === "off") setHook(args[0]);
      const env = /^(off|0|false|no)$/i.test(process.env.USAGE_HANDOFF_HOOK ?? "");
      return out(`usage-handoff hook: ${hookEnabled() ? "on" : "off"}${env ? " (USAGE_HANDOFF_HOOK is set)" : ""}`);
    }
    case "mark-messaged": {
      const messaged = { ...(state.messaged ?? {}) };
      for (const f of args) messaged[fwd(path.resolve(f))] = Date.now();
      writeState({ ...state, messaged });
      return out({ messaged: Object.keys(messaged).length });
    }
    case "mark-resumed":
      markResumed(args[0], flag(args, "--by", "unknown"));
      return out(`resumed: ${fwd(args[0])}`);
    case "finish-resume":
      writeState({ phase: "watching", threshold: state.threshold, lastResumeAt: iso(Date.now()), messaged: state.messaged ?? {} });
      clearLocks({ phase: "watching" });
      return out("watching");
    case "launch": {
      const file = args.find((a) => !a.startsWith("--"));
      const h = parseHandoff(readFileSync(file, "utf8"));
      if (h.sessionid && openSessions().has(h.sessionid) && !args.includes("--force")) {
        throw new Error(`session ${h.sessionid} is still open; message it instead (--force opens a second copy)`);
      }
      const resumeId = hasTranscript(h.sessionid) ? h.sessionid : null;
      out({ launched: launch(h.cwd, resumePrompt(file), args.includes("--dry-run"), resumeId), cwd: h.cwd, resumed: resumeId });
      return 0;
    }
    case "wake":
      await wake();
      return 0;
    case "status":
      return out({ ...state, ...(state.resumeAt ? { resumeAtLocal: localTime(state.resumeAt) } : {}), waker: state.waker ? { ...state.waker, alive: alive(state.waker.pid) } : null, handoffDir: fwd(handoffDir()) });
    case "reset":
      writeState({ phase: "watching", threshold: state.threshold });
      clearLocks({ phase: "watching" });
      return out("reset: watching");
    case "statusline": {
      // A status line command gets session JSON on stdin; this line needs none of it.
      let cache = null;
      try { cache = JSON.parse(readFileSync(cacheFile(), "utf8")); } catch {}
      return out(statusText({ cache, state }));
    }
    case "rehearse":
      return rehearse();
    case "paths":
      return out({ home: fwd(home()), handoffs: fwd(handoffDir()), log: fwd(logFile()), script: fwd(SCRIPT) });
    default:
      console.error(`unknown command: ${cmd}`);
      return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SCRIPT)) {
  // exitCode, not process.exit(): exiting while fetch's sockets close trips a libuv assert on Windows.
  main(process.argv.slice(2)).then((code) => { process.exitCode = code ?? 0; }, (e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  });
}
