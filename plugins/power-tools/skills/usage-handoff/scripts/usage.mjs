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
//   status | reset | paths
//
// Configuration (all optional):
//   USAGE_HANDOFF_HOME     state, handoffs and logs (default: ~/.claude/usage-handoff)
//   USAGE_HANDOFF_CMD      a command that prints usage JSON in the /api/oauth/usage shape
//   USAGE_HANDOFF_FIXTURE  a JSON file to read instead (tests)
//   CLAUDE_CONFIG_DIR      where Claude Code keeps .credentials.json (default: ~/.claude)
//
// The usage endpoint is the one Claude Code's /usage reads. It isn't a documented API, so every
// failure is reported as action "unknown" instead of guessed.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, appendFileSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
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

// Handoff files: Markdown with "Key: value" header lines.
export function parseHandoff(text) {
  const out = {};
  for (const line of text.split(/\r?\n/).slice(0, 30)) {
    const m = /^(Status|Session|Cwd|Branch|PR|Written|Resets):\s*(.*)$/.exec(line.trim());
    if (m && !(m[1].toLowerCase() in out)) out[m[1].toLowerCase()] = m[2].trim();
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
    const canTake = held.by === by || (held.by === "waker" && by !== "waker") || !held.at || now - held.at > STALE_CLAIM_MS;
    if (!canTake) return { claimed: false, by: held.by };
    writeFileSync(lock, body);
    return { claimed: true, by, tookOverFrom: held.by };
  }
}

// Text that survives cmd.exe, wt and shell quoting: no quotes, separators or redirections.
const safe = (s) => s.replace(/["`$;&|<>^%!]/g, "'").replace(/\s+/g, " ").trim();

export const resumePrompt = (file) => safe(`Resume from the usage handoff at ${fwd(file)}. Read it first, set its Status line to resumed by plus your session name, run git status in its Cwd, then carry on with its Next steps. Restart any subagent work it lists under In flight.`);
export const RESUMER_PROMPT = safe("Claude usage has reset. Run the usage-handoff skill with the argument resume to restart the sessions that wrote handoffs.");

// The command that opens a new terminal running `claude <prompt>` in cwd, or null if none is known.
export function launchCommand({ platform = process.platform, cwd, prompt, has = onPath }) {
  const p = safe(prompt);
  if (platform === "win32") {
    const dir = cwd.replace(/\//g, "\\");
    if (has("wt.exe") || has("wt")) return { cmd: "wt.exe", args: ["-w", "new", "-d", dir, "cmd", "/k", "claude", p] };
    return { cmd: "cmd.exe", args: [`/c start "claude resume" /D "${dir}" cmd /k claude "${p}"`], verbatim: true };
  }
  const sh = `cd '${cwd.replace(/'/g, "'\\''")}' && claude '${p}'`;
  if (platform === "darwin") {
    return { cmd: "osascript", args: ["-e", `tell application "Terminal" to do script "${sh.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`] };
  }
  for (const [term, flag] of [["x-terminal-emulator", "-e"], ["gnome-terminal", "--"], ["konsole", "-e"], ["xterm", "-e"]]) {
    if (has(term)) return { cmd: term, args: [flag, "bash", "-lc", `${sh}; exec bash`] };
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

function launch(cwd, prompt, dryRun) {
  if (!cwd || !existsSync(cwd)) throw new Error(`folder not found: ${cwd}`);
  const c = launchCommand({ cwd, prompt });
  if (!c) throw new Error(`no terminal found; run this yourself: cd "${cwd}" && claude "${safe(prompt)}"`);
  if (dryRun || process.env.USAGE_HANDOFF_DRY_LAUNCH) return c; // the env var is for tests
  spawn(c.cmd, c.args, { detached: true, stdio: "ignore", windowsVerbatimArguments: !!c.verbatim }).unref();
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

// Background process: wait for the reset, then start one Claude session that runs the resume.
async function wake() {
  log(`waker ${process.pid} started`);
  await sleep(5000); // let mark-handoff save this process's pid first
  for (let i = 0; i < 10_000; i++) {
    const state = readState();
    if (state.phase === "watching" || state.waker?.pid !== process.pid) return log(`waker ${process.pid}: not needed any more, exiting`);
    const resumeAt = Date.parse(state.resumeAt) || Date.now();
    const wait = resumeAt + WAKER_GRACE_S * 1000 - Date.now();
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
    const claim = claimResume("waker", state);
    if (claim.claimed) writeState({ ...readState(), phase: "resuming" });
    else {
      await sleep(5 * 60_000); // a session is resuming; check again in case it stops halfway
      continue;
    }
    try {
      const c = launch(state.cwd || homedir(), RESUMER_PROMPT, false);
      log(`waker ${process.pid}: started a resume session in ${state.cwd}: ${c.cmd} ${c.args.join(" ")}`);
    } catch (e) {
      log(`waker ${process.pid}: could not start a session: ${e.message}`);
    }
    return;
  }
}

function flag(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

async function main(argv) {
  const [cmd = "check", ...args] = argv;
  const out = (o) => console.log(typeof o === "string" ? o : JSON.stringify(o, null, 2));
  const state = readState();

  switch (cmd) {
    case "check": {
      const threshold = Number(flag(args, "--threshold", state.threshold ?? DEFAULT_THRESHOLD));
      if (state.threshold !== threshold) writeState({ ...state, threshold });
      const { windows, error } = await readWindows();
      const d = decide({ windows, state, threshold });
      const handoffs = listHandoffs();
      return out({
        ...d,
        phase: state.phase ?? "watching",
        ...(error ? { error } : {}),
        windows: (windows ?? []).map((w) => ({ name: w.name, pct: w.pct, resetsAt: w.resetsAt ? iso(w.resetsAt) : null })),
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
      return out({ phase: next.phase, resumeAt: next.resumeAt, waker: next.waker ?? null, handoffDir: fwd(handoffDir()) });
    }
    case "claim-resume": {
      const r = claimResume(flag(args, "--by", "unknown"), state);
      if (r.claimed) writeState({ ...state, phase: "resuming" });
      out(r);
      return r.claimed ? 0 : 3;
    }
    case "pending":
      return out(listHandoffs().filter(isPending));
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
      return out("watching");
    case "launch": {
      const file = args.find((a) => !a.startsWith("--"));
      const h = parseHandoff(readFileSync(file, "utf8"));
      out({ launched: launch(h.cwd, resumePrompt(file), args.includes("--dry-run")), cwd: h.cwd });
      return 0;
    }
    case "wake":
      await wake();
      return 0;
    case "status":
      return out({ ...state, waker: state.waker ? { ...state.waker, alive: alive(state.waker.pid) } : null, handoffDir: fwd(handoffDir()) });
    case "reset":
      writeState({ phase: "watching", threshold: state.threshold });
      return out("reset: watching");
    case "paths":
      return out({ home: fwd(home()), handoffs: fwd(handoffDir()), log: fwd(logFile()) });
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
