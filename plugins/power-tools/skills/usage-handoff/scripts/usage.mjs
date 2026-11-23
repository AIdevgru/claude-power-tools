#!/usr/bin/env node
// Usage watcher for /usage-handoff. Reads the account's Claude usage windows (the numbers `/usage`
// shows), decides whether the fleet should write handoffs, and restarts the work once the limit
// resets.
//
//   check [--threshold N] [--finish-at N]
//                                JSON: usage, the action to take (watch | handoff | wait | resume |
//                                unknown) and when to check next. The threshold defaults to 95
//                                (percent); --finish-at (default 99) is how far the finisher goes.
//   await-handoffs --session-id ID
//                                (the coordinator) Wait until every open session's handoff is
//                                written (at most 9 minutes), then print this session's role (finish
//                                or wait) and the restart job to schedule.
//   job --id JOB --session-id ID | job --clear
//                                Record (or forget) the scheduled restart job and which session has it.
//   continue --session-id ID --round R --by NAME [--now]
//                                (the scheduled restart job) expired | early | nothing | claimed |
//                                continue. A job made under another login, or for an earlier limit,
//                                is expired. --now (by hand) restarts even before the reset.
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
//   statusline [--no-link]       One line for Claude Code's status line, from the shared reading
//                                (read again once it's older than the hooks' cache time):
//                                the session's model (from the JSON on stdin), the logged-in
//                                account and each window's usage and reset, as a link to the
//                                accounts page.
//   show [model|email|usage] [on|off|toggle]
//                                Switch one part of the status line (all on by default; stored in
//                                config.json). With no value it prints the part's setting, with no
//                                part every part's. /show-model, /show-email and /show-usage run it.
//   accounts [--json]          Every account this machine has logged in to, with its last usage
//                                and resets. `accounts forget EMAIL` drops one.
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
//   USAGE_HANDOFF_ACCOUNT  the logged-in account as JSON {key, email} instead of .claude.json (tests)
//   USAGE_HANDOFF_AWAIT_S  how long await-handoffs waits at most (default 540)
//   CLAUDE_CONFIG_DIR      where Claude Code keeps .credentials.json (default: ~/.claude) and
//                          .claude.json, which names the logged-in account (default: ~/.claude.json)
//
// The usage endpoint is the one Claude Code's /usage reads. It isn't a documented API, so every
// failure is reported as action "unknown" instead of guessed.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync, appendFileSync, openSync, closeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_THRESHOLD = 95;
export const MIN_WAKE_S = 60;
export const MAX_WAKE_S = 3600; // ScheduleWakeup's ceiling
export const RESUME_GRACE_S = 60; // the watcher's own wakeup lands this long after the reset
export const WAKER_GRACE_S = 180; // the background waker waits longer, so a live watcher wins
export const STALE_CLAIM_MS = 30 * 60_000;
export const MESSAGED_STALE_MS = 15 * 60_000;
export const DEFAULT_FINISH_AT = 99; // the finisher stops here, leaving room to update its handoff
export const AWAIT_S = 540; // under the 10-minute ceiling of one Bash call
export const JOB_DELAY_S = 60; // the restart job runs this long after the reset, before the waker
const SCRIPT = fileURLToPath(import.meta.url);
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export const home = () => process.env.USAGE_HANDOFF_HOME || path.join(homedir(), ".claude", "usage-handoff");
export const handoffDir = () => path.join(home(), "handoffs");
const stateFile = () => path.join(home(), "state.json");
const logFile = () => path.join(home(), "waker.log");
const fwd = (p) => p.replace(/\\/g, "/");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
// A limit's round: when it started, to the millisecond, so two limits never share one.
const roundId = (ms) => new Date(ms).toISOString();

export function readState() {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8"));
  } catch {
    return { phase: "watching" };
  }
}

// Atomic: a hook reading mid-write must never see "watching" and start a fresh round.
export function writeState(state) {
  mkdirSync(home(), { recursive: true });
  writeAtomic(stateFile(), JSON.stringify(state, null, 2) + "\n");
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

// The window being waited for reset before its predicted time (limits sometimes reset early).
// Usage within a window only rises, so it's a reset when nothing is at the threshold any more and
// no window still resets at the time being waited for: that window rolled over to a new one.
export function resetEarly({ windows, state = {}, now = Date.now(), threshold = DEFAULT_THRESHOLD }) {
  const resumeAt = Date.parse(state.resumeAt);
  if (!windows?.length || !Number.isFinite(resumeAt) || now >= resumeAt) return false;
  if (windows.some((w) => w.pct >= threshold)) return false;
  return !windows.some((w) => w.resetsAt != null && Math.abs(w.resetsAt - resumeAt) < 5 * 60_000);
}

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
  if (resetEarly({ windows, state, now, threshold })) return { ...out, action: "resume", early: true, nextCheckSeconds: MIN_WAKE_S };
  if (now < resumeAt) return { ...out, action: "wait", nextCheckSeconds: clampWake((resumeAt - now) / 1000 + RESUME_GRACE_S) };
  if (hot.length) return { ...out, action: "wait", nextCheckSeconds: 300 }; // reset passed but the reading hasn't caught up
  return { ...out, action: "resume", nextCheckSeconds: MIN_WAKE_S };
}

function credentials() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
  const file = path.join(dir, ".credentials.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).claudeAiOauth;
  if (process.platform === "darwin") {
    const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    return JSON.parse(raw).claudeAiOauth;
  }
  throw new Error(`no Claude Code login found at ${fwd(file)}`);
}

// Which login a reading belongs to: a short hash of the saved token (never the token itself),
// "none" when there's no login, null when usage comes from a fixture or a command. Logging in,
// logging out or a renewed token changes it, so the next hook call or status line reads again
// instead of showing the old login's reading (or its "not logged in" error) until the cache expires.
export function loginStamp(env = process.env) {
  if (env.USAGE_HANDOFF_FIXTURE || env.USAGE_HANDOFF_CMD) return null;
  try {
    const token = credentials()?.accessToken;
    return token ? createHash("sha256").update(token).digest("hex").slice(0, 12) : "none";
  } catch {
    return "none";
  }
}

// Returns the raw usage JSON, or throws with a one-line reason.
export async function fetchUsage() {
  if (process.env.USAGE_HANDOFF_FIXTURE) return JSON.parse(readFileSync(process.env.USAGE_HANDOFF_FIXTURE, "utf8"));
  if (process.env.USAGE_HANDOFF_CMD) {
    return JSON.parse(execFileSync(process.env.USAGE_HANDOFF_CMD, { encoding: "utf8", shell: true, timeout: 30_000, windowsHide: true }));
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
  if (pct >= threshold) return 30_000; // only the finisher (and sessions writing handoffs) still work
  if (pct >= threshold - 10) return 60_000;
  if (pct >= threshold - 20) return 5 * 60_000;
  return 10 * 60_000;
}

// force: read now (the /usage-handoff tick), but still share the reading with the hooks.
// login: loginStamp() now. A reading taken under another login is stale whatever its age.
// identify: who is logged in (currentAccount); each reading is filed under that account.
export async function cachedWindows(now = Date.now(), threshold = DEFAULT_THRESHOLD, read = readWindows, force = false, login = loginStamp(), identify = currentAccount) {
  let cache = {};
  try { cache = JSON.parse(readFileSync(cacheFile(), "utf8")); } catch {}
  const pct = cache.windows?.[0]?.pct ?? null;
  const sameLogin = login == null || cache.login === login;
  const fresh = cache.at && now - cache.at < cacheTtlMs(pct, threshold) && sameLogin;
  const leased = cache.leaseAt && now - cache.leaseAt < 30_000; // another session is reading right now
  if (!force && (fresh || leased)) {
    const filed = fresh ? fileReading(cache, { now, login, identify }) : cache;
    return { windows: cache.windows ?? null, error: cache.error, cached: true, account: filed.account ?? null };
  }
  mkdirSync(home(), { recursive: true });
  writeFileSync(cacheFile(), JSON.stringify({ ...cache, leaseAt: now }));
  const r = await read();
  const next = { at: now, windows: r.windows, ...(r.error ? { error: r.error } : {}), ...(login != null ? { login } : {}) };
  writeFileSync(cacheFile(), JSON.stringify(next));
  return { ...r, cached: false, account: fileReading(next, { now, login, identify }).account ?? null };
}

// The status line's reading. It reads again by the hooks' rule, through their shared cache: when
// the reading is older than cacheTtlMs (10 minutes far from the limit, 30 seconds at it), or the
// login changed since it was taken (the owner just logged in, say). So it stays current with the
// hook off, and every session's line and hook together still make one request per interval.
export async function statusCache({ now = Date.now(), threshold = DEFAULT_THRESHOLD, read = readWindows, login = loginStamp(), identify = currentAccount } = {}) {
  let cache = readJson(cacheFile(), null);
  const old = !cache?.at || now - cache.at >= cacheTtlMs(cache.windows?.[0]?.pct ?? null, threshold);
  if (old || (login != null && cache?.login !== login)) {
    await cachedWindows(now, threshold, read, false, login, identify);
    cache = readJson(cacheFile(), cache);
  }
  return fileReading(cache, { now, login, identify });
}

// ---- accounts: every Claude account this machine has logged in to, and its last reading ----
//
// accounts.json keeps one entry per account (and organization): who it is, its plan, when it was
// last logged in, and its last usage reading with each window's reset. Each fresh reading is filed
// under the account it was taken with, so after a switch to another login the other accounts keep
// their numbers and resets. accounts.html shows them all; the status line links to it.

const accountsFile = () => path.join(home(), "accounts.json");
export const accountsPage = () => path.join(home(), "accounts.html");
export const accountsUrl = () => pathToFileURL(accountsPage()).href;
const SETTLE_MS = 10_000;

// "Max 5x", "Pro", "Team": from the organization type and rate-limit tier Claude Code saves.
export function planLabel({ type, tier } = {}) {
  const s = `${type ?? ""} ${tier ?? ""}`.toLowerCase();
  if (s.includes("enterprise")) return "Enterprise";
  if (s.includes("team")) return "Team";
  const max = /max_(\d+)x/.exec(s);
  if (max) return `Max ${max[1]}x`;
  if (s.includes("max")) return "Max";
  if (s.includes("pro")) return "Pro";
  return null;
}

// Who is logged in, from what Claude Code saves at login (.claude.json's oauthAccount), never the
// token. null when nobody is (or the usage comes from a test fixture). undefined while a login is
// still being saved: the token is written a moment before the account, and a reading taken in
// between must not be filed under the previous account, so it waits for the next call.
export function currentAccount(login = loginStamp(), now = Date.now(), env = process.env) {
  if (env.USAGE_HANDOFF_ACCOUNT) {
    try { return JSON.parse(env.USAGE_HANDOFF_ACCOUNT); } catch { return null; }
  }
  if (login === "none" || env.USAGE_HANDOFF_FIXTURE) return null;
  const dir = env.CLAUDE_CONFIG_DIR;
  try {
    const age = now - statSync(path.join(dir || path.join(homedir(), ".claude"), ".credentials.json")).mtimeMs;
    if (Math.abs(age) < SETTLE_MS) return undefined;
  } catch {}
  const files = dir
    ? [path.join(dir, ".claude.json"), path.join(dir, ".config.json")]
    : [path.join(homedir(), ".claude.json"), path.join(homedir(), ".claude", ".config.json")];
  for (const f of files) {
    const a = readJson(f, null)?.oauthAccount;
    if (!a?.emailAddress && !a?.accountUuid) continue;
    // A personal organization is named after its owner ("lee@example.com's Organization"): noise.
    const team = /team|enterprise/i.test(a.organizationType ?? "");
    return {
      key: [a.accountUuid || a.emailAddress, a.organizationUuid].filter(Boolean).join("/"),
      email: a.emailAddress ?? null,
      name: a.displayName ?? null,
      org: team ? a.organizationName ?? null : null,
      plan: planLabel({ type: a.organizationType, tier: a.userRateLimitTier || a.organizationRateLimitTier }),
    };
  }
  return null;
}

export function readAccounts(file = accountsFile()) {
  const b = readJson(file, null);
  return { current: b?.current ?? null, accounts: b?.accounts && typeof b.accounts === "object" ? b.accounts : {} };
}

// Readers (the status line, an open page) never see half a file.
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch {
    rmSync(tmp, { force: true });
    writeFileSync(file, text);
  }
}

export function writeAccounts(book, now = Date.now()) {
  mkdirSync(home(), { recursive: true });
  writeAtomic(accountsFile(), JSON.stringify(book, null, 2) + "\n");
  writeAtomic(accountsPage(), accountsHtml(book, { now, threshold: readState().threshold ?? DEFAULT_THRESHOLD }));
}

// Files one reading under its account, which becomes the current one. Its windows and resets
// replace the ones it had; a failed reading keeps its last good numbers and notes the error.
// account null: nobody is logged in, so no account is current.
export function recordReading(account, reading, now = Date.now()) {
  const book = readAccounts();
  if (!account) {
    if (book.current !== null) {
      book.current = null;
      writeAccounts(book, now);
    }
    return book;
  }
  const prev = book.accounts[account.key] ?? { firstSeen: iso(now) };
  if (prev.readAt && reading.at && Date.parse(prev.readAt) > reading.at) return book; // an older reading, filed late
  const entry = { ...prev, email: account.email, name: account.name, org: account.org, plan: account.plan, lastSeen: iso(now) };
  if (book.current !== account.key || !prev.since) entry.since = iso(now); // logged in (again)
  if (reading.windows) {
    entry.windows = reading.windows.map((w) => ({ name: w.name, pct: w.pct, resetsAt: w.resetsAt ? iso(w.resetsAt) : null }));
    entry.readAt = iso(reading.at ?? now);
    delete entry.error;
    delete entry.errorAt;
  } else if (reading.error) {
    entry.error = reading.error;
    entry.errorAt = iso(reading.at ?? now);
  }
  book.current = account.key;
  book.accounts[account.key] = entry;
  writeAccounts(book, now);
  return book;
}

// Files the shared reading under the account it was taken with, once: the cache remembers the
// account, so later calls only read a field. A reading from another login than the current one
// is left alone; it was filed (or not) by the session that took it.
export function fileReading(cache, { now = Date.now(), login = null, identify = currentAccount } = {}) {
  if (!cache?.at || cache.account !== undefined) return cache;
  if (login != null && cache.login !== login) return cache;
  try {
    const account = identify(cache.login ?? login, now);
    if (account === undefined) return cache; // the login is still being saved: next call
    const latest = readJson(cacheFile(), null);
    if (latest?.at === cache.at) writeFileSync(cacheFile(), JSON.stringify({ ...latest, account }));
    recordReading(account, cache, now);
    return { ...cache, account };
  } catch {
    return cache; // filing is an extra: it never costs the reading
  }
}

export function forgetAccount(match) {
  const book = readAccounts();
  const m = String(match ?? "").trim().toLowerCase();
  const gone = Object.keys(book.accounts).filter((k) => m && (k.toLowerCase() === m || (book.accounts[k].email ?? "").toLowerCase() === m));
  for (const k of gone) delete book.accounts[k];
  if (gone.includes(book.current)) book.current = null;
  if (gone.length) writeAccounts(book);
  return gone.length;
}

// The current account first, then the most recently used.
export function sortedAccounts(book) {
  return Object.entries(book?.accounts ?? {})
    .map(([key, a]) => ({ key, a, current: key === book.current }))
    .sort((x, y) => Number(y.current) - Number(x.current) || (Date.parse(y.a.lastSeen) || 0) - (Date.parse(x.a.lastSeen) || 0));
}

export function hookEnabled(env = process.env) {
  if (/^(off|0|false|no)$/i.test(env.USAGE_HANDOFF_HOOK ?? "")) return false;
  try { return JSON.parse(readFileSync(configFile(), "utf8")).hook !== "off"; } catch { return true; }
}

function readConfig() {
  try { return JSON.parse(readFileSync(configFile(), "utf8")) ?? {}; } catch { return {}; }
}

function writeConfig(patch) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify({ ...readConfig(), ...patch }, null, 2) + "\n");
}

const setHook = (value) => writeConfig({ hook: value });

// The status line's parts, each with its own switch (/show-model, /show-email, /show-usage). All
// are on unless config.json's `show` turns one off.
export const SHOW_PARTS = { model: "the session's model", email: "the logged-in account", usage: "each window's usage and reset" };
// Own keys only: "constructor" or "toString" isn't a part.
export const isPart = (part) => Object.hasOwn(SHOW_PARTS, part);

export function showSettings(cfg = readConfig()) {
  const show = cfg?.show ?? {};
  return Object.fromEntries(Object.keys(SHOW_PARTS).map((p) => [p, show[p] !== false]));
}

// Sets one part on or off ("toggle" flips it) and returns every part's setting.
export function setShow(part, value) {
  if (!isPart(part)) throw new Error(`show: no part ${part}; parts: ${Object.keys(SHOW_PARTS).join(", ")}`);
  if (!["on", "off", "toggle"].includes(value)) throw new Error(`show ${part}: on, off or toggle, not ${value}`);
  const cfg = readConfig();
  const now = showSettings(cfg);
  const next = value === "toggle" ? !now[part] : value === "on";
  writeConfig({ show: { ...(cfg.show ?? {}), [part]: next } });
  return { ...now, [part]: next };
}

// Whether the user's settings run this script's status line, so a switch has something to change.
// settings.local.json wins over settings.json, as in Claude Code. The path may be quoted either way.
export function statusLineSet(dir = claudeDir()) {
  for (const file of ["settings.local.json", "settings.json"]) {
    let cmd;
    try { cmd = JSON.parse(readFileSync(path.join(dir, file), "utf8"))?.statusLine?.command; } catch { continue; }
    if (typeof cmd === "string") return /usage\.mjs['"]?\s+statusline\b/.test(cmd);
  }
  return false;
}

// One line per switch: "show-model: on (the session's model)".
export function showText(show, parts = Object.keys(SHOW_PARTS)) {
  return parts.map((p) => `show-${p}: ${show[p] ? "on" : "off"} (${SHOW_PARTS[p]})`).join("\n");
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

// One "## Heading" section's text, without the heading.
export function sectionText(text, heading) {
  const lines = String(text).split(/\r?\n/);
  const i = lines.findIndex((l) => l.trim().toLowerCase().startsWith(`## ${heading.toLowerCase()}`));
  if (i < 0) return "";
  const out = [];
  for (const l of lines.slice(i + 1)) {
    if (/^## /.test(l)) break;
    out.push(l);
  }
  return out.join("\n").trim();
}

// A handoff its session has written: its name on the Session line and something under Next steps.
// The hook's skeleton has neither.
export function isFilled(text) {
  const h = parseHandoff(text);
  return Boolean(h.session && !h.session.startsWith("(fill in") && sectionText(text, "Next steps"));
}

export function listHandoffs(dir = handoffDir()) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => {
    const file = path.join(dir, f);
    const text = readFileSync(file, "utf8");
    return { file: fwd(file), name: f.slice(0, -3), mtime: statSync(file).mtimeMs, ...parseHandoff(text), filled: isFilled(text) };
  });
}

// The handoffs the coordinator still waits for: this limit's handoffs that aren't written yet and
// whose session is still open. A session that closed (or ran out mid-turn) can't write any more.
export function waitingOn({ state = {}, handoffs = [], open = new Map(), self = null }) {
  const since = Date.parse(state.round) || 0;
  return handoffs.filter((h) => isPending(h) && !h.filled && h.mtime >= since - 60_000 && h.sessionid && h.sessionid !== self && open.has(h.sessionid));
}

// A different account is logged in than the one that hit the limit. Only a definite change counts:
// null (logged out, a test fixture) or undefined (a login still being saved) never does.
export function loginChanged(state = {}, account) {
  const was = state.account?.key;
  return Boolean(was && account?.key && account.key !== was);
}

// ---- the restart job: a one-time scheduled task in one session, at the reset ----

// A minute after the reset, never on :00 or :30 (the scheduler may run those up to 90 s early).
export function jobTime(resumeAt, now = Date.now()) {
  const t = Math.max(typeof resumeAt === "string" ? Date.parse(resumeAt) : resumeAt, now);
  const d = new Date(Math.ceil((t + JOB_DELAY_S * 1000) / 60_000) * 60_000);
  if (d.getMinutes() % 30 === 0) d.setMinutes(d.getMinutes() + 1);
  return d;
}

// One day of the year, in local time: CronCreate reads cron in the owner's zone.
export const cronAt = (d) => `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;

export const jobPrompt = ({ sessionId, round }) =>
  `Scheduled usage-handoff restart: the Claude usage limit should have reset. Run the usage-handoff skill with the argument "continue --session-id ${sessionId} --round ${round}". It checks the login hasn't changed, then tells every session to carry on.`;

// What the session schedules with CronCreate (recurring false).
export function jobSpec({ resumeAt, sessionId, round, now = Date.now() }) {
  const at = jobTime(resumeAt, now);
  return { cron: cronAt(at), runsAt: iso(at.getTime()), runsAtLocal: localTime(at.getTime(), now), prompt: jobPrompt({ sessionId, round }) };
}

// What the restart job does when it runs. decision: decide() on a fresh reading.
// now: run by hand, so restart even before the reset (like resume).
// claimBy: who holds the resume claim. A claim the waker holds can be taken over (claimResume).
export function continuePlan({ state = {}, account, decision, sessionId = null, round = null, now = false, at = Date.now(), claimBy = null }) {
  if (now) return { action: "continue" };
  // The hook or the waker already cancelled this round when the login changed.
  if (round && state.expired?.round === round) {
    return { action: "expired", why: `the login changed from ${state.expired.from ?? "the account that hit the limit"} to ${state.expired.to ?? "another account"}` };
  }
  if (state.phase === "handoff" && loginChanged(state, account)) {
    return { action: "expired", why: `the login changed from ${state.account.email ?? "the account that hit the limit"} to ${account.email ?? "another account"}` };
  }
  if (round && state.round && round !== state.round) return { action: "expired", why: "it was made for an earlier limit" };
  if (state.job?.sessionId && sessionId && state.job.sessionId !== sessionId) return { action: "expired", why: "a newer restart job in another session replaced it" };
  if ((state.phase ?? "watching") === "watching") return { action: "nothing", why: "nothing is waiting for a reset" };
  // A session (the waker's hidden one, or another) is restarting everyone right now. If only the
  // waker holds the claim, its session may not have started: this job takes over.
  if (state.phase === "resuming" && claimBy !== "waker" && at - (Date.parse(state.resumingSince) || 0) < STALE_CLAIM_MS) {
    return { action: "nothing", why: "the sessions are already being restarted" };
  }
  if (state.phase === "handoff" && decision?.action === "wait") return { action: "early", resumeAt: decision.resumeAt };
  return { action: "continue" };
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
const resumeLock = (state) => path.join(home(), `resume-${String(state.resumeAt ?? "now").replace(/[^\w-]/g, "")}.lock`);
// Who holds this reset's resume claim, or null.
export const resumeClaimBy = (state = readState()) => readJson(resumeLock(state), {}).by ?? null;

export function claimResume(by, state = readState(), now = Date.now()) {
  mkdirSync(home(), { recursive: true });
  const lock = resumeLock(state);
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
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
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
    execFileSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore", timeout: 5000, windowsHide: true });
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

// How the hidden resume session is started. The waker has no console, so on Windows a detached
// claude would have none either, and every program it runs (hooks, git, shells) would open its own
// visible console window and take focus. Started attached with windowsHide, it gets one hidden
// console that all of them share. Windows ends an attached child when its parent exits, so the
// waker waits for the session to finish.
export const resumerSpawn = (platform = process.platform) =>
  platform === "win32" ? { detached: false, windowsHide: true, wait: true } : { detached: true, windowsHide: true, wait: false };

// Starts the hidden resume session in cwd. No window; its output goes to resumer.log. done
// resolves with its exit code when the waker has to wait for it, and is null otherwise.
function startResumer(cwd) {
  const c = resumerCommand();
  if (process.env.USAGE_HANDOFF_DRY_LAUNCH) return { ...c, done: null }; // tests
  mkdirSync(home(), { recursive: true });
  appendFileSync(resumerLog(), `\n--- ${iso(Date.now())} resume session in ${fwd(cwd)}\n`);
  const fd = openSync(resumerLog(), "a");
  const { wait, ...how } = resumerSpawn();
  const child = spawn(c.cmd, c.args, { cwd, ...how, windowsVerbatimArguments: !!c.verbatim, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  if (!wait) {
    child.unref();
    return { ...c, done: null };
  }
  const done = new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", (e) => resolve(`error: ${e.message}`));
  });
  return { ...c, done };
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
  try { names = readdirSync(dir).filter((n) => /^(resume|finisher|coordinator)-.*\.lock$/.test(n)); } catch {}
  const at = String(state.resumeAt ?? "now").replace(/[^\w-]/g, "");
  const current = [`resume-${at}.lock`, `coordinator-${at}.lock`, `finisher-${String(state.round ?? "now").replace(/[^\w-]/g, "")}.lock`];
  return names.filter((n) => state.phase === "watching" || !current.includes(n)).map((n) => path.join(dir, n));
}
const clearLocks = (state) => { for (const f of staleLocks(state)) rmSync(f, { force: true }); };

// Back to watching after a login change: the old account's restart (its job, finisher and waker)
// no longer applies. Handoffs stay pending; `/usage-handoff resume` restarts them by hand.
export function expireRound(state, account, now = Date.now()) {
  const next = {
    phase: "watching", ...KEEP(state), messaged: state.messaged ?? {},
    expired: {
      from: state.account?.email ?? state.account?.key ?? null, to: account?.email ?? account?.key ?? null,
      round: state.round ?? null, job: state.job ?? null, at: iso(now),
    },
  };
  writeState(next);
  clearLocks(next);
  // Sessions told about the old account's limit must hear about the new account's.
  clearNotified();
  return next;
}

// The rest of this limit's state, kept across the reset's watching phase.
function KEEP(state) { return { threshold: state.threshold, finishAt: state.finishAt }; }

// A limit starts a new round unless one is waiting for a reset that is still ahead. A phase stuck
// at "resuming" (the resume session stopped early) doesn't hold the next limit back, but a resume
// started by hand before the reset does: the same limit (resumeAt, its reset) is still on.
export function freshRound(state = {}, now = Date.now(), resumeAt = null) {
  const cur = Date.parse(state.resumeAt);
  if (state.phase === "handoff") return Number.isFinite(cur) && cur <= now;
  if (state.phase === "resuming") {
    if (!Number.isFinite(cur) || cur <= now) return true;
    return resumeAt == null || Math.abs(resumeAt - cur) > 60_000;
  }
  return true;
}

const accountField = (account) => (account?.key ? { account: { key: account.key, email: account.email ?? null } } : {});

// Background process: wait for the reset, then start one Claude session that runs the resume.
async function wake() {
  log(`waker ${process.pid} started`);
  await sleep(5000); // let mark-handoff save this process's pid first
  for (let i = 0; i < 10_000; i++) {
    const state = readState();
    if (state.phase === "watching" || state.waker?.pid !== process.pid) return log(`waker ${process.pid}: not needed any more, exiting`);
    // The restart belongs to the account that hit the limit; another login cancels it.
    const account = state.phase === "handoff" ? currentAccount() : null;
    if (state.phase === "handoff" && loginChanged(state, account)) {
      expireRound(state, account);
      return log(`waker ${process.pid}: the login changed to ${account.email ?? "another account"}, so the restart for ${state.account.email ?? "the old account"} is cancelled`);
    }
    const resumeAt = Date.parse(state.resumeAt) || Date.now();
    // A session's restart job runs a minute after the reset; give it time before starting another.
    const jobGrace = state.job?.sessionId && openSessions().has(state.job.sessionId) ? 600 : 0;
    const wait = resumeAt + (graceS() + jobGrace) * 1000 - Date.now();
    if (wait > 0) {
      // While waiting, look at the shared reading (no extra calls while hooks keep it fresh) in
      // case the window resets early.
      const threshold = state.threshold ?? DEFAULT_THRESHOLD;
      const { windows: reading } = await cachedWindows(Date.now(), threshold);
      if (!resetEarly({ windows: reading, state, threshold })) {
        await sleep(Math.min(wait, 10 * 60_000));
        continue;
      }
      log(`waker ${process.pid}: the limit reset early`);
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
      const cur = readState();
      writeState({ phase: "watching", ...KEEP(cur), messaged: cur.messaged ?? {}, lastResumeAt: iso(Date.now()) });
      clearLocks({ phase: "watching" });
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
      if (c.done) log(`waker ${process.pid}: the resume session ended (exit ${await c.done})`);
    } catch (e) {
      log(`waker ${process.pid}: could not start the resume session: ${e.message}`);
    }
    return;
  }
}

// ---- hook mode ----

const notifiedFile = () => path.join(home(), "notified.json");
const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } };
function clearNotified() { try { rmSync(notifiedFile(), { force: true }); } catch {} }
// The time of day in the owner's zone, 12-hour: "12:10 AM EST".
export function clockTime(ms) {
  // Newer ICU puts a narrow no-break space before AM/PM; a plain space reads the same everywhere.
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).replace(/[\u202f\u00a0]/g, " ");
}

// The owner reads times in their own zone: "12:10 AM EST", with the date when it isn't today.
export function localTime(ms, now = Date.now()) {
  const t = typeof ms === "string" ? Date.parse(ms) : ms;
  if (!Number.isFinite(t)) return null;
  try {
    const d = new Date(t);
    const time = clockTime(t);
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
// The windows at or over the threshold, and the latest of their resets.
function hotWindows(windows, threshold, now) {
  // A reading whose reset time has passed is stale: the window is already empty again.
  const hot = (windows ?? []).filter((w) => w.pct >= threshold && (w.resetsAt == null || w.resetsAt > now));
  return { hot, resumeAt: hot.length ? Math.max(...hot.map((w) => w.resetsAt ?? now + MAX_WAKE_S * 1000)) : null };
}

// The reset moved later: a hot window with a known reset more than a minute past the recorded one.
// (Stored times drop the fraction of a second, and a window with no reset time is a guess.)
export function movedReset(windows, threshold, resumeAt, now = Date.now()) {
  const cur = typeof resumeAt === "string" ? Date.parse(resumeAt) : resumeAt;
  const known = hotWindows(windows, threshold, now).hot.filter((w) => w.resetsAt != null).map((w) => w.resetsAt);
  const later = known.length ? Math.max(...known) : null;
  return later && (!Number.isFinite(cur) || later > cur + 60_000) ? later : null;
}

// finisher: the session using up the rest of the window. It (and its subagents) keep working until
// its finishAt, and then hear once more: stop.
export function hookPlan({ input, windows, threshold = DEFAULT_THRESHOLD, notified = {}, now = Date.now(), finisher = null }) {
  if (!input?.session_id) return null;
  const finishing = finisher?.sessionId === input.session_id;
  const key = `${input.session_id}:${input.agent_id || (finishing ? "finish" : "main")}`;
  if (notified[key] && Date.parse(notified[key]) > now) return null;
  const extra = finishing && !input.agent_id ? { finish: true } : {};
  // The round's reset: the finisher's job runs then, even when a sooner window is the one at 99%.
  const roundReset = finishing ? Date.parse(finisher.resumeAt) : NaN;
  // The finisher works above the threshold, so it must see the usage: no reading means stop.
  // (Once the reset has passed there's room again, so a failed reading is no reason to stop.)
  if (finishing && !windows) {
    if (!(roundReset > now)) return null;
    return { key, resumeAt: roundReset, pct: null, window: null, subagent: Boolean(input.agent_id), noReading: true, ...extra };
  }
  const { hot, resumeAt } = hotWindows(windows, finishing ? finisher.finishAt : threshold, now);
  if (!hot.length) return null;
  const reset = Number.isFinite(roundReset) ? Math.max(resumeAt, roundReset) : resumeAt;
  return { key, resumeAt: reset, pct: hot[0].pct, window: hot[0].name, subagent: Boolean(input.agent_id), ...extra };
}

// role: { coordinator, sessionId, finishAt, script } for the session that coordinates this limit.
export function hookMessage(plan, file, role = {}) {
  const local = localTime(plan.resumeAt);
  const window = String(plan.window ?? "usage").replace(/_/g, "-");
  const blind = `usage-handoff: the usage reading failed, so this session can't see how much of the window is left (resets ${local}).`;
  const head = plan.noReading ? blind : `usage-handoff: Claude usage is at ${plan.pct}% of the ${window} limit (resets ${local}).`;
  if (plan.subagent) {
    return `${head} Stop at the next safe point: finish or undo the step you're on, start nothing new, and end with a short report for your parent session: your goal, what's done, what's left, your worktree and branch, and any uncommitted changes.`;
  }
  if (plan.finish) {
    return [
      plan.noReading ? `${blind} Stop now:` : `usage-handoff: Claude usage is at ${plan.pct}% of the ${window} limit, as far as this session was to go (resets ${local}). Stop now:`,
      "1. Finish or undo the step you're on and start nothing new. Ask any subagent you have running to stop at a safe point and report.",
      `2. Update your handoff at ${fwd(file)} so its Done and Next steps say where you are now. Leave its Status line as pending.`,
      "3. Check with CronList (load it with ToolSearch if it's deferred) that your restart job is still scheduled. Keep this session open: the job runs only while it is.",
      `4. End your turn. At the reset (${local}) the job tells every session to carry on.`,
    ].join("\n");
  }
  const lines = [
    `${head} Wrap up before it runs out:`,
    "1. Stop starting new work, and don't launch new subagents.",
    "2. Tell each subagent you have running (SendMessage to its id) to stop at a safe point and report its goal, what's done, what's left, its worktree and branch, and any uncommitted changes.",
    "3. Save uncommitted work as a WIP commit on your own branch if the repo's rules allow (never git stash).",
    `4. Fill in your handoff at ${fwd(file)}: Read it, put your session name on the Session line, and write each section so a fresh session could carry on.`,
  ];
  if (role.coordinator) {
    const node = `node "${fwd(role.script ?? SCRIPT)}"`;
    lines.push(
      `5. You coordinate this limit. Once your handoff is written, run \`${node} await-handoffs --session-id ${role.sessionId}\` with Bash (timeout 600000). It waits, without using usage, until the other open sessions have written theirs (at most 9 minutes), then prints your role and a restart job.`,
      `6. Schedule the restart: CronCreate with its job.cron, recurring false, and its job.prompt word for word (if CronCreate is deferred, load it with ToolSearch "select:CronCreate,CronDelete,CronList"). Then run \`${node} job --id <the job id CronCreate returned> --session-id ${role.sessionId}\`. Keep this session open: the job runs only while it is. If job is null, nothing is waiting for a reset any more: skip this step.`,
      `7. If its role is "finish", use up the rest of this window: carry on with your handoff's Next steps, keeping the handoff current, until the hook tells you to stop${role.finishAt ? ` (at ${role.finishAt}%)` : ""}. Otherwise end your turn. When you tell the owner a time, use their local time as written here, not UTC.`,
    );
  } else {
    lines.push(`5. End your turn. After the reset (${local}) this session is reopened or messaged and told to resume from that file. When you tell the owner a time, use their local time as written here, not UTC.`);
  }
  lines.push("The owner can turn this off with /usage-handoff off.");
  return lines.join("\n");
}

// The note for a session whose restart job no longer matches the limit: the reset moved.
export function jobMovedMessage(job, spec, sessionId, script = SCRIPT) {
  const node = `node "${fwd(script)}"`;
  return [
    `usage-handoff: the reset you're waiting for moved to ${localTime(spec.runsAt)}, so your restart job (${job.id}) would run too early.`,
    `Replace it: CronDelete ${job.id}, then CronCreate with cron "${spec.cron}", recurring false, and this prompt word for word (load both with ToolSearch "select:CronCreate,CronDelete" if they're deferred): ${spec.prompt}`,
    `Then run \`${node} job --id <the new job id> --session-id ${sessionId}\`, and carry on with what you were doing.`,
  ].join("\n");
}

export function loginMessage(expired, pending, job, sessionId) {
  const mine = job?.id && job.sessionId === sessionId ? ` Delete your restart job with CronDelete ${job.id} (load it with ToolSearch if it's deferred).` : "";
  return `usage-handoff: the login changed from ${expired.from ?? "the account that hit the limit"} to ${expired.to ?? "another account"}, so the restart scheduled for the old account's reset is cancelled.${mine}${pending ? ` ${pending} handoff(s) are still pending; /usage-handoff resume restarts them now, on this account.` : ""}`;
}

function ensureSkeleton(input, resumeAt, now) {
  const file = path.join(handoffDir(), `${handoffSlug(input.cwd, input.session_id)}.md`);
  if (existsSync(file) && isPending(parseHandoff(readFileSync(file, "utf8")))) return file;
  let branch = "-";
  try {
    branch = execFileSync("git", ["-C", input.cwd, "branch", "--show-current"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim() || "-";
  } catch {}
  mkdirSync(handoffDir(), { recursive: true });
  writeFileSync(file, skeleton({ sessionId: input.session_id, cwd: input.cwd || process.cwd(), branch, resumeAt, now }));
  return file;
}

// A new limit starts a round: its time, the account that hit it, and (from the first main session
// the hook tells) its coordinator. A later reset (another window filled) moves the wait.
export function armedState(st, { resumeAt, cwd, now, sessionId = null, account = null }) {
  // A reset that has passed is no limit to wait for.
  if (!(resumeAt > now)) return st;
  const cur = Date.parse(st.resumeAt);
  let next = st;
  if (freshRound(st, now, resumeAt)) {
    next = {
      ...KEEP(st), phase: "handoff", resumeAt: iso(resumeAt), cwd: fwd(cwd || process.cwd()),
      requestedAt: iso(now), round: roundId(now), ...accountField(account), messaged: {},
    };
  } else if (!Number.isFinite(cur) || cur + 60_000 < resumeAt) {
    next = { ...st, resumeAt: iso(resumeAt), requestedAt: iso(now), messaged: {}, round: st.round ?? roundId(now) };
  }
  if (sessionId && !next.coordinator) next = { ...next, coordinator: { sessionId, at: iso(now) } };
  return next;
}

// The first session to see the threshold records the reset and starts the waker; later ones only
// make sure a waker is still running. Returns the state.
function ensureArmed(resumeAt, cwd, now, sessionId = null, account = null) {
  const st = readState();
  const fresh = freshRound(st, now, resumeAt);
  let armed = armedState(st, { resumeAt, cwd, now, sessionId, account: fresh ? account ?? currentAccount() : null });
  // Hooks crossing the threshold at the same moment each start the round in their own copy of the
  // state. The lock picks one coordinator, and every copy names it, whichever is written last.
  if (sessionId && armed.phase === "handoff" && armed.coordinator?.sessionId === sessionId) {
    const holder = claimCoordinator(armed, sessionId, now);
    if (holder !== sessionId) armed = { ...armed, coordinator: holder ? { sessionId: holder, at: armed.coordinator.at } : null };
  }
  const waker = armWaker(armed);
  if (armed === st && waker === st.waker) return st; // nothing changed: don't rewrite the file
  const next = { ...armed, waker };
  writeState(next);
  return next;
}

export async function runHook(raw, now = Date.now()) {
  if (!hookEnabled()) return null;
  const input = JSON.parse(raw || "{}");
  const event = input.hook_event_name;
  if (event !== "UserPromptSubmit" && event !== "PostToolUse") return null;
  let st = readState();
  const threshold = st.threshold ?? DEFAULT_THRESHOLD;
  const { windows, account } = await cachedWindows(now, threshold);
  const notified = readJson(notifiedFile(), {});
  const tell = (key, text) => {
    for (const [k, v] of Object.entries(notified)) if (Date.parse(v) < now - 24 * 3600_000) delete notified[k];
    notified[key] = iso(now + 24 * 3600_000);
    writeFileSync(notifiedFile(), JSON.stringify(notified, null, 2));
    return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
  };

  if (st.phase === "handoff") {
    if (loginChanged(st, account)) {
      // The restart is locked to the account that hit the limit: another login cancels it.
      // (account: who the shared reading was taken as; a new login re-reads at once.)
      st = expireRound(st, account, now);
      for (const k of Object.keys(notified)) delete notified[k];
    } else {
      // Usage moved on: another window filled up, so the reset is later. Follow it, and tell the
      // session holding the restart job to move it.
      const later = movedReset(windows, threshold, st.resumeAt, now);
      if (later) st = ensureArmed(later, st.cwd, now);
      const job = st.job;
      if (job?.sessionId === input.session_id && !input.agent_id && st.phase === "handoff" && job.resumeAt !== st.resumeAt) {
        const key = `${input.session_id}:job:${st.resumeAt}`;
        if (!notified[key]) return tell(key, jobMovedMessage(job, jobSpec({ resumeAt: st.resumeAt, sessionId: input.session_id, round: st.round, now }), input.session_id));
      }
    }
  }
  // A login change cancelled the round (in this hook, another session's, the waker or the job).
  // Tell the first main session to come by, and the session that held the restart job.
  const ex = st.phase === "watching" ? st.expired : null;
  if (ex?.at && !input.agent_id && now - Date.parse(ex.at) < 24 * 3600_000) {
    const all = `login:${ex.at}`;
    const mine = `${input.session_id}:login:${ex.at}`;
    if (!notified[mine] && (!notified[all] || ex.job?.sessionId === input.session_id)) {
      notified[all] = iso(now + 24 * 3600_000);
      return tell(mine, loginMessage(ex, listHandoffs().filter(isPending).length, ex.job, input.session_id));
    }
  }

  const finisher = st.phase === "handoff" && st.finisher?.round === st.round ? { ...st.finisher, resumeAt: st.resumeAt } : null;
  const plan = hookPlan({ input, windows, threshold, notified, now, finisher });
  if (!plan) {
    // A restart is due but its waker is gone (the machine rebooted, say): start one, and it
    // resumes right away.
    const st = readState();
    // Only while waiting for the reset; once a resume has started it owns the restart, unless it
    // has been stuck for longer than a claim lasts.
    const stuck = st.phase === "resuming" && now - (Date.parse(st.resumingSince) || now) > STALE_CLAIM_MS;
    const due = Date.parse(st.resumeAt) < now || (st.phase === "handoff" && resetEarly({ windows, state: st, now, threshold }));
    if ((st.phase === "handoff" || stuck) && due && !(st.waker?.pid && alive(st.waker.pid))) {
      writeState({ ...st, waker: armWaker({ ...st, waker: null }) });
    }
    return null;
  }
  const file = plan.subagent ? null : ensureSkeleton(input, plan.resumeAt, now);
  for (const [k, v] of Object.entries(notified)) if (Date.parse(v) < now - 24 * 3600_000) delete notified[k];
  notified[plan.key] = iso(plan.resumeAt);
  writeFileSync(notifiedFile(), JSON.stringify(notified, null, 2));
  const armed = ensureArmed(plan.resumeAt, input.cwd, now, plan.subagent || plan.finish ? null : input.session_id, account);
  const finishAt = armed.finishAt ?? DEFAULT_FINISH_AT;
  const coordinates = !plan.subagent && !plan.finish && armed.phase === "handoff" && armed.coordinator?.sessionId === input.session_id;
  const role = coordinates ? { coordinator: true, sessionId: input.session_id, finishAt: finishAt > threshold ? finishAt : null } : {};
  return { hookSpecificOutput: { hookEventName: event, additionalContext: hookMessage(plan, file, role) } };
}

// ---- the coordinator: wait for the handoffs, then pick the finisher and the restart job ----

const awaitS = () => {
  const v = Number(process.env.USAGE_HANDOFF_AWAIT_S);
  return Number.isFinite(v) && v >= 0 && process.env.USAGE_HANDOFF_AWAIT_S !== "" ? v : AWAIT_S;
};

// One coordinator per limit: the session holding the lock for this reset. Returns its session id.
function claimCoordinator(state, sessionId, now) {
  mkdirSync(home(), { recursive: true });
  const lock = path.join(home(), `coordinator-${String(state.resumeAt ?? "now").replace(/[^\w-]/g, "")}.lock`);
  try {
    const fd = openSync(lock, "wx");
    try { writeSync(fd, JSON.stringify({ sessionId, at: now })); } finally { closeSync(fd); }
    return sessionId;
  } catch {
    // The winner writes its id right after creating the file: give it a moment.
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 20; i++) {
      const holder = readJson(lock, {}).sessionId;
      if (holder) return holder;
      Atomics.wait(pause, 0, 0, 5);
    }
    return null;
  }
}

// One finisher per limit, even if two sessions ask at once.
function claimFinisher(state, sessionId, now) {
  const lock = path.join(home(), `finisher-${String(state.round ?? "now").replace(/[^\w-]/g, "")}.lock`);
  try {
    closeSync(openSync(lock, "wx"));
    writeFileSync(lock, JSON.stringify({ sessionId, at: now }));
    return true;
  } catch {
    return readJson(lock, {}).sessionId === sessionId;
  }
}

// The coordinator's role once the handoffs are in. finish: the window still has room up to
// finishAt, so this session keeps working; wait: it stops like the rest.
export function roleFor({ state, windows, sessionId, now = Date.now() }) {
  const threshold = state.threshold ?? DEFAULT_THRESHOLD;
  const finishAt = state.finishAt ?? DEFAULT_FINISH_AT;
  if (state.phase !== "handoff") return { role: "wait", why: "nothing is waiting for a reset" };
  if (finishAt <= threshold) return { role: "wait", why: `finishing is off (finish-at ${finishAt} is not above the threshold ${threshold})` };
  if (state.finisher?.round === state.round && state.finisher.sessionId !== sessionId) return { role: "wait", why: "another session is finishing" };
  if (!windows?.length) return { role: "wait", why: "the usage reading failed, so there's no telling how much is left" };
  const pct = hotWindows(windows, threshold, now).hot[0]?.pct ?? windows[0].pct;
  if (pct >= finishAt) return { role: "wait", why: `usage is already at ${pct}%` };
  return { role: "finish", finishAt, pct };
}

async function awaitHandoffs(sessionId, { timeoutS = awaitS(), pollMs = 3000 } = {}) {
  const end = Date.now() + timeoutS * 1000;
  let waiting = [];
  for (;;) {
    const state = readState();
    const handoffs = listHandoffs();
    const mine = handoffs.find((h) => h.sessionid === sessionId && isPending(h));
    if (mine && !mine.filled) return { error: `write your handoff first: ${mine.file}`, code: 4 };
    waiting = waitingOn({ state, handoffs, open: openSessions(), self: sessionId });
    if (!waiting.length || Date.now() >= end) break;
    await sleep(pollMs);
  }
  const now = Date.now();
  let state = readState();
  const { windows } = await cachedWindows(now, state.threshold ?? DEFAULT_THRESHOLD);
  let r = roleFor({ state, windows, sessionId, now });
  if (r.role === "finish" && !claimFinisher(state, sessionId, now)) r = { role: "wait", why: "another session is finishing" };
  if (r.role === "finish") {
    state = { ...readState(), finisher: { sessionId, round: state.round, finishAt: r.finishAt, since: iso(now) } };
    writeState(state);
  }
  const written = listHandoffs().filter((h) => isPending(h) && h.filled && h.mtime >= (Date.parse(state.round) || 0) - 60_000).length;
  const job = state.phase === "handoff" && state.resumeAt ? jobSpec({ resumeAt: state.resumeAt, sessionId, round: state.round, now }) : null;
  return {
    ...r, written,
    waitingOn: waiting.map((h) => h.session && !h.session.startsWith("(fill in") ? h.session : h.name),
    ...(waiting.length ? { timedOut: true } : {}),
    resumeAt: state.resumeAt ?? null, resumeAtLocal: state.resumeAt ? localTime(state.resumeAt, now) : null,
    job,
    ...(state.job?.id && state.job.sessionId !== sessionId ? { otherJob: state.job } : {}),
  };
}

// ---- status line ----

const WINDOW_LABELS = { five_hour: "5h", seven_day: "week" };

// localTime, shorter for the status line: "12:10 AM EST" today, "Sun 4:00 PM EST" within the week.
export function shortLocalTime(ms, now = Date.now()) {
  const full = localTime(ms, now);
  // A weekday alone only for 1 to 6 calendar days ahead: next Monday, seen on a Monday, needs its date.
  const day = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const days = Math.round((day(ms) - day(now)) / 86_400_000);
  if (!full || days < 1 || days > 6) return full;
  try {
    return `${new Date(ms).toLocaleDateString("en-US", { weekday: "short" })} ${clockTime(ms)}`;
  } catch { return full; }
}

// A fixed order (5h, then week, then any others), so a line doesn't reshuffle as usage moves.
const windowOrder = (w) => { const i = Object.keys(WINDOW_LABELS).indexOf(w.name); return i < 0 ? 99 : i; };
const byWindow = (a, b) => windowOrder(a) - windowOrder(b);
const shortLabel = (name) => WINDOW_LABELS[name] ?? name.replace(/_/g, "-");
const toMs = (v) => (typeof v === "number" ? v : Date.parse(v));

// OSC 8: text the terminal opens as a link (Ctrl+click, or Cmd+click on macOS).
export const hyperlink = (url, text) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

// The session's model as Claude Code names it ("Opus 5.5"), from the JSON it sends a status line
// command on stdin; its id when there's no display name, null when there's neither or the input
// isn't JSON. One short line of plain text: it lands in the terminal.
export function sessionModel(input) {
  let m;
  // A PowerShell pipe (a status line wrapped in a .ps1) starts the JSON with a byte order mark.
  try { m = JSON.parse(String(input).replace(/^\uFEFF/, ""))?.model; } catch { return null; }
  const name = typeof m === "string" ? m : m?.display_name || m?.id;
  if (typeof name !== "string") return null;
  const text = name.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  return text ? (text.length > 40 ? `${text.slice(0, 39)}…` : text) : null;
}

// What Claude Code wrote to the status line command's stdin, or "" when nothing was piped in (run
// by hand in a terminal, stdin is the keyboard: reading it would wait for Ctrl+Z).
function statusInput() {
  if (process.stdin.isTTY) return "";
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

// One short line for Claude Code's status line, from the shared cache only (no API call):
// "Opus 5.5 · lee@example.com (+1) · 5h 64% (resets 12:10 AM EST) · week 49% (resets Sun 4:00 PM EST)".
// The session's model comes first, then the account. Each window carries its own reset, so it's
// clear which one resets when. "(+1)" counts the other accounts this machine knows; with link, the
// whole line opens the page that lists them all. `show` (from showSettings) leaves parts out: email
// off drops the account and its count, usage off the windows, their age and any error. A handoff
// in progress is still named, since it's the fleet stopping, not a number.
export function statusText({ cache, state = {}, now = Date.now(), book = null, link = null, model = null, show = showSettings({}) }) {
  const windows = (cache?.windows ?? []).filter((w) => typeof w.pct === "number").sort(byWindow);
  const account = cache?.account ?? null;
  const others = Object.keys(book?.accounts ?? {}).filter((k) => k !== account?.key).length;
  const parts = [];
  if (show.model && model) parts.push(model);
  if (show.email && account?.email) parts.push(others ? `${account.email} (+${others})` : account.email);
  if (show.usage) {
    if (!windows.length) parts.push(cache?.error ? `usage: ${cache.error}` : "usage: no reading yet");
    for (const w of windows) {
      const label = `${shortLabel(w.name)} ${Math.round(w.pct)}%`;
      parts.push(w.resetsAt && w.resetsAt > now ? `${label} (resets ${shortLocalTime(w.resetsAt, now)})` : label);
    }
  }
  // A handoff in progress is named with or without a reading, and with usage off.
  if (state.phase === "handoff" && windows.length && resetEarly({ windows, state, now, threshold: state.threshold ?? DEFAULT_THRESHOLD })) parts.push("reset early, resuming");
  else if (state.phase === "handoff" && state.resumeAt) parts.push(`handing off, back ${shortLocalTime(Date.parse(state.resumeAt), now)}`);
  else if (state.phase === "resuming") parts.push("resuming");
  const ageMin = windows.length && cache?.at ? Math.round((now - cache.at) / 60_000) : null;
  if (show.usage && ageMin != null && ageMin >= 15) parts.push(`${ageMin} min old`);
  if (show.email && !account?.email && others) parts.push(`${others} account${others === 1 ? "" : "s"}`);
  const text = parts.join(" · ");
  return link && text ? hyperlink(link, text) : text;
}

// ---- every account, for the terminal and the accounts page ----

// One line per account, the logged-in one first and starred:
// "* lee@example.com (Max 5x) · 5h 64% (resets 12:10 AM EST) · week 49% (resets Sun 4:00 PM EST) · logged in since 9:02 AM EST"
// A reset that has passed since the reading says so: "5h reset 4:10 PM EST (was 97%)".
export function accountsText(book, now = Date.now()) {
  const rows = sortedAccounts(book);
  if (!rows.length) return "No accounts recorded yet: usage is filed under the logged-in account each time it's read.";
  return rows.map(({ key, a, current }) => {
    const about = [a.plan, a.org].filter(Boolean).join(", ");
    const parts = [`${a.email ?? key}${about ? ` (${about})` : ""}`];
    const windows = (a.windows ?? []).filter((w) => typeof w.pct === "number").sort(byWindow);
    for (const w of windows) {
      const pct = Math.round(w.pct);
      const t = toMs(w.resetsAt);
      if (!Number.isFinite(t)) parts.push(`${shortLabel(w.name)} ${pct}%`);
      else if (t <= now) parts.push(`${shortLabel(w.name)} reset ${shortLocalTime(t, now)} (was ${pct}%)`);
      else parts.push(`${shortLabel(w.name)} ${pct}% (resets ${shortLocalTime(t, now)})`);
    }
    if (!windows.length) parts.push("no reading yet");
    if (a.error) parts.push(`last read failed: ${a.error}`);
    const seen = toMs(current ? a.since : a.lastSeen);
    if (Number.isFinite(seen)) parts.push(`${current ? "logged in since" : "last used"} ${shortLocalTime(seen, now)}`);
    return `${current ? "*" : " "} ${parts.join(" · ")}`;
  }).join("\n");
}

const WINDOW_NAMES = { five_hour: "5-hour", seven_day: "Weekly", seven_day_opus: "Weekly, Opus", seven_day_sonnet: "Weekly, Sonnet" };
const windowName = (n) => WINDOW_NAMES[n] ?? n.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// "2 h 5 min", "3 d 4 h": how far away a time is. The page's script uses this same function.
export function span(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 1) return "under a minute";
  if (m < 60) return m + " min";
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? h + " h " + (m % 60) + " min" : h + " h";
  const d = Math.floor(h / 24);
  return h % 24 ? d + " d " + (h % 24) + " h" : d + " d";
}
const ago = (ms) => (ms < 60000 ? "just now" : span(ms) + " ago");

// The meter's state: the fill turns amber within 15 points of the threshold and red at it.
const meterLevel = (pct, threshold) => (pct >= threshold ? "full" : pct >= threshold - 15 ? "near" : "ok");

function windowRow(w, now, threshold) {
  const pct = Math.round(w.pct);
  const t = toMs(w.resetsAt);
  const known = Number.isFinite(t);
  const level = meterLevel(w.pct, threshold);
  const flag = level === "full" ? ' · <b class="flag">at the limit</b>' : level === "near" ? ' · <b class="flag">near the limit</b>' : "";
  const when = known ? esc(shortLocalTime(t, now)) : "";
  const live = known
    ? `resets ${when} <span class="rel" data-until="${iso(t)}">${t > now ? `(in ${span(t - now)})` : ""}</span>${flag}`
    : `${pct === 0 ? "starts at first use" : "no reset time"}${flag}`;
  const name = esc(windowName(w.name));
  return `<li class="win ${level}${known && t <= now ? " reset" : ""}"${known ? ` data-resets="${iso(t)}"` : ""}>
      <span class="name">${name}</span>
      <span class="meter" role="meter" aria-label="${name} usage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${Math.min(100, Math.max(0, w.pct))}%"></span></span>
      <span class="pct"><span class="live">${pct}%</span><span class="after">&ndash;</span></span>
      <span class="when"><span class="live">${live}</span><span class="after">reset ${when} (was ${pct}%)</span></span>
    </li>`;
}

function accountCard({ key, a, current }, now, threshold) {
  const windows = (a.windows ?? []).filter((w) => typeof w.pct === "number").sort(byWindow);
  const about = [a.name && a.name !== a.email ? a.name : null, a.plan, a.org].filter(Boolean).join(" · ");
  const seenAt = toMs(current ? a.since : a.lastSeen);
  const seen = Number.isFinite(seenAt) ? `${current ? "Logged in since" : "Last used"} ${esc(shortLocalTime(seenAt, now))}` : "";
  const readAt = toMs(a.readAt);
  const read = Number.isFinite(readAt) ? `read <span data-ago="${iso(readAt)}">${ago(now - readAt)}</span>` : "";
  const foot = [seen, read].filter(Boolean).join(", ");
  const errAt = toMs(a.errorAt);
  return `<article class="account${current ? " current" : ""}">
  <header><h2>${esc(a.email ?? key)}</h2>${current ? '<span class="badge">Logged in</span>' : ""}</header>
  ${about ? `<p class="meta">${esc(about)}</p>` : ""}
  ${windows.length ? `<ul class="windows">\n    ${windows.map((w) => windowRow(w, now, threshold)).join("\n    ")}\n  </ul>` : '<p class="empty">No usage read for this account yet.</p>'}
  ${foot ? `<p class="foot">${foot}</p>` : ""}
  ${a.error ? `<p class="error"><b>Last read failed${Number.isFinite(errAt) ? ` at ${esc(shortLocalTime(errAt, now))}` : ""}:</b> ${esc(a.error)}</p>` : ""}
</article>`;
}

const PAGE_CSS = `
:root { color-scheme: light dark; --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --line: rgba(11,11,11,.10); --accent: #2a78d6; --near: #fab219; --full: #d03b3b; }
@media (prefers-color-scheme: dark) { :root { --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --line: rgba(255,255,255,.10); --accent: #3987e5; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 780px; margin: 0 auto; padding: 40px 20px 56px; }
.top { margin-bottom: 24px; }
h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 4px; }
.top p, footer p { color: var(--ink-2); margin: 0; }
.account { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; margin-bottom: 12px; }
.account.current { box-shadow: inset 3px 0 0 var(--accent); }
.account header { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
h2 { font-size: 16px; font-weight: 600; margin: 0; overflow-wrap: anywhere; }
.badge { font-size: 12px; font-weight: 600; color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); border-radius: 999px; padding: 1px 8px; }
.meta { color: var(--ink-2); font-size: 13px; margin: 2px 0 0; }
.windows { list-style: none; margin: 14px 0 0; padding: 0; display: grid; gap: 10px; }
.win { display: grid; grid-template-columns: 96px minmax(90px, 1fr) 44px minmax(0, 1.7fr); align-items: center; gap: 4px 12px; }
.name, .when { color: var(--ink-2); font-size: 13px; }
.meter { --fill: var(--accent); display: block; height: 8px; border-radius: 999px; overflow: hidden; background: color-mix(in srgb, var(--fill) 18%, var(--surface)); }
.meter > span { display: block; height: 100%; border-radius: 999px; background: var(--fill); }
.win.near .meter { --fill: var(--near); }
.win.full .meter { --fill: var(--full); }
.win.reset .meter { --fill: var(--accent); }
.win.reset .meter > span { width: 0 !important; }
.pct { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
.flag { color: var(--ink); font-weight: 600; }
.win .after, .win.reset .live { display: none; }
.win.reset .after { display: inline; }
.empty { color: var(--ink-2); font-size: 13px; margin: 12px 0 0; }
.foot { color: var(--ink-2); font-size: 12px; margin: 14px 0 0; }
.error { font-size: 13px; margin: 6px 0 0; }
.none { background: var(--surface); border: 1px dashed var(--line); border-radius: 10px; padding: 24px 20px; color: var(--ink-2); margin: 0; }
footer { margin-top: 28px; font-size: 12px; }
code { font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
@media (max-width: 560px) { .win { grid-template-columns: 72px 1fr 44px; } .when { grid-column: 2 / -1; } }
@media (forced-colors: active) { .meter { border: 1px solid CanvasText; } .meter > span { background: CanvasText; } }
`;

// The page keeps its relative times current, and greys out a window whose reset passes while it's open.
const PAGE_JS = `${span.toString()}
function tick() {
  var now = Date.now();
  document.querySelectorAll("[data-ago]").forEach(function (el) {
    var d = now - Date.parse(el.dataset.ago);
    el.textContent = d < 60000 ? "just now" : span(d) + " ago";
  });
  document.querySelectorAll(".win[data-resets]").forEach(function (w) {
    var t = Date.parse(w.dataset.resets);
    w.classList.toggle("reset", t <= now);
    var rel = w.querySelector("[data-until]");
    if (rel) rel.textContent = t > now ? "(in " + span(t - now) + ")" : "";
  });
}
tick();
setInterval(tick, 30000);`;

// accounts.html: one card per account with a meter per window and its reset. Static, so the
// status line can link to it as a file; it reloads every minute to pick up new readings.
export function accountsHtml(book, { now = Date.now(), threshold = DEFAULT_THRESHOLD } = {}) {
  const rows = sortedAccounts(book);
  const body = rows.length
    ? rows.map((r) => accountCard(r, now, threshold)).join("\n")
    : `<p class="none">No accounts yet. Each time usage-handoff reads your usage, it files it under the account you're logged in with. Send a prompt in any Claude Code session, then reload this page.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Claude accounts: usage and resets</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<main>
<header class="top">
  <h1>Claude accounts</h1>
  <p>Usage and resets for each account this machine has logged in to. Updated ${esc(clockTime(now))} (<span data-ago="${iso(now)}">just now</span>).</p>
</header>
${body}
<footer>
  <p>An account you're not logged in to shows its last reading on this machine; what it used elsewhere since then isn't counted. Kept in <code>${esc(fwd(accountsFile()))}</code>; <code>/usage-handoff accounts forget &lt;email&gt;</code> drops an account. This page reloads every minute.</p>
</footer>
</main>
<script>
${PAGE_JS}
</script>
</body>
</html>
`;
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
  const run = (args, input = "") => execFileSync(process.execPath, [SCRIPT, ...args], { env, input, encoding: "utf8", cwd: work, windowsHide: true });
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

// Pending handoffs. open: the session is still running (message it); canReopen: claude --resume
// can bring it back.
function pendingList() {
  const open = openSessions();
  return listHandoffs().filter(isPending).map((h) => ({ ...h, open: h.sessionid ? open.has(h.sessionid) : null, canReopen: hasTranscript(h.sessionid) }));
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
      const finishAt = Number(flag(args, "--finish-at", state.finishAt ?? DEFAULT_FINISH_AT));
      if (state.threshold !== threshold || (state.finishAt ?? DEFAULT_FINISH_AT) !== finishAt) writeState({ ...state, threshold, finishAt });
      const { windows, error, account } = await cachedWindows(Date.now(), threshold, readWindows, true);
      const d = decide({ windows, state, threshold });
      const handoffs = listHandoffs();
      return out({
        ...d,
        ...(d.resumeAt ? { resumeAtLocal: localTime(d.resumeAt) } : {}),
        phase: state.phase ?? "watching",
        ...(account?.email ? { account: account.email } : {}),
        ...(error ? { error } : {}),
        windows: (windows ?? []).map((w) => ({ name: w.name, pct: w.pct, resetsAt: w.resetsAt ? iso(w.resetsAt) : null, resetsAtLocal: w.resetsAt ? localTime(w.resetsAt) : null })),
        handoffDir: fwd(handoffDir()),
        pending: handoffs.filter(isPending).length,
        stalePending: stalePending(state, handoffs),
        waker: state.waker ? { ...state.waker, alive: alive(state.waker.pid) } : null,
        finishAt,
        ...(state.coordinator ? { coordinator: state.coordinator.sessionId } : {}),
        ...(state.finisher?.round && state.finisher.round === state.round ? { finisher: state.finisher.sessionId } : {}),
        ...(state.job ? { job: { ...state.job, runsAtLocal: localTime(state.job.runsAt) } } : {}),
      });
    }
    case "mark-handoff": {
      // A new limit starts a round, as the hook does: nothing of the last one carries over.
      const now = Date.now();
      const base = freshRound(state, now, Date.parse(flag(args, "--resume-at", "")) || null) ? { ...KEEP(state), round: roundId(now), ...accountField(currentAccount()) } : state;
      const next = {
        ...base,
        round: base.round ?? roundId(now),
        phase: "handoff",
        resumeAt: flag(args, "--resume-at", base.resumeAt),
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
    case "pending":
      return out(pendingList());
    case "await-handoffs": {
      const sessionId = flag(args, "--session-id", null);
      if (!sessionId) throw new Error("await-handoffs --session-id ID");
      const r = await awaitHandoffs(sessionId);
      out(r);
      return r.code ?? 0;
    }
    case "job": {
      if (args.includes("--clear")) {
        writeState({ ...state, job: null });
        return out("restart job: none");
      }
      const id = flag(args, "--id", null);
      const sessionId = flag(args, "--session-id", null);
      if (!id || !sessionId) throw new Error("job --id JOB --session-id ID");
      if (state.phase !== "handoff") throw new Error("no limit is waiting for a reset, so there's nothing to schedule");
      // --runs-at: the time actually scheduled (continue's early answer picks a later one).
      const given = Date.parse(flag(args, "--runs-at", ""));
      const runsAt = Number.isFinite(given) ? iso(given) : jobSpec({ resumeAt: state.resumeAt, sessionId, round: state.round }).runsAt;
      const job = { id, sessionId, resumeAt: state.resumeAt, round: state.round ?? null, runsAt, account: state.account?.key ?? null, email: state.account?.email ?? null, at: iso(Date.now()) };
      writeState({ ...state, job });
      return out({ job, runsAtLocal: localTime(runsAt), ...(state.job?.sessionId && state.job.sessionId !== sessionId ? { replaced: state.job } : {}) });
    }
    case "continue": {
      const sessionId = flag(args, "--session-id", null);
      const threshold = state.threshold ?? DEFAULT_THRESHOLD;
      const { windows } = await cachedWindows(Date.now(), threshold, readWindows, true);
      const decision = decide({ windows, state, threshold });
      const account = currentAccount();
      const p = continuePlan({ state, account, decision, sessionId, round: flag(args, "--round", null), now: args.includes("--now"), claimBy: resumeClaimBy(state) });
      if (p.action === "expired") {
        // Only the login change ends the round. A stale job leaves the current round's job alone.
        // This job has just fired, so nobody needs telling to delete it.
        if (state.phase === "handoff" && loginChanged(state, account)) {
          expireRound({ ...state, job: state.job?.sessionId === sessionId ? null : state.job }, account);
        }
        return out(p);
      }
      if (p.action === "nothing") return out(p);
      if (p.action === "early") {
        // Not reset yet (or the reading lags): run again then. Never schedule a time that has passed.
        const when = Math.max(Date.parse(p.resumeAt) || Date.now(), Date.now() + (decision.nextCheckSeconds - JOB_DELAY_S) * 1000);
        if (p.resumeAt && p.resumeAt !== state.resumeAt) writeState({ ...state, resumeAt: p.resumeAt });
        return out({ ...p, resumeAtLocal: localTime(p.resumeAt), job: jobSpec({ resumeAt: when, sessionId, round: state.round }) });
      }
      const claim = claimResume(flag(args, "--by", "unknown"), state);
      if (!claim.claimed) return out({ action: "claimed", by: claim.by, why: `${claim.by} is already restarting the sessions` });
      writeState({ ...readState(), phase: "resuming", resumingSince: iso(Date.now()), job: null });
      return out({ action: "continue", pending: pendingList(), handoffDir: fwd(handoffDir()) });
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
      // A new limit started while the sessions were restarting: that round is still waiting.
      if (state.phase === "handoff" && Date.parse(state.resumeAt) > Date.now()) {
        return out(`still waiting: a new limit started, resets ${localTime(state.resumeAt)}`);
      }
      writeState({ phase: "watching", ...KEEP(state), lastResumeAt: iso(Date.now()), messaged: state.messaged ?? {} });
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
      writeState({ phase: "watching", ...KEEP(state) });
      clearLocks({ phase: "watching" });
      return out("reset: watching");
    case "statusline": {
      // A status line command gets the session's JSON on stdin; the line takes only its model.
      const model = sessionModel(statusInput());
      const cache = await statusCache({ threshold: state.threshold ?? DEFAULT_THRESHOLD });
      const book = readAccounts();
      try {
        if (!existsSync(accountsPage())) writeAccounts(book); // so the link opens something from the start
      } catch {} // the line matters more than the page
      return out(statusText({ cache, state, book, model, show: showSettings(), link: args.includes("--no-link") ? null : accountsUrl() }));
    }
    case "show": {
      const [part, value] = args;
      if (!part) return out(showText(showSettings()));
      if (!isPart(part)) throw new Error(`show: no part ${part}; parts: ${Object.keys(SHOW_PARTS).join(", ")}`);
      const show = value ? setShow(part, value) : showSettings();
      const lines = [showText(show, [part])];
      if (value && !Object.values(show).some(Boolean)) lines.push("Every part is off, so the status line is empty.");
      if (!statusLineSet()) lines.push("The status line isn't set up yet: /usage-handoff statusline shows how.");
      return out(lines.join("\n"));
    }
    case "accounts": {
      if (args[0] === "forget") {
        const who = args.slice(1).join(" ");
        const n = forgetAccount(who);
        return out(n ? `forgot ${who}` : `no account matches ${who || "(nothing given)"}`);
      }
      const book = readAccounts();
      writeAccounts(book); // the page's times are as of now
      if (args.includes("--json")) return out({ ...book, page: fwd(accountsPage()), url: accountsUrl() });
      return out(`${accountsText(book)}\npage: ${accountsUrl()}`);
    }
    case "rehearse":
      return rehearse();
    case "paths":
      return out({ home: fwd(home()), handoffs: fwd(handoffDir()), log: fwd(logFile()), accounts: fwd(accountsPage()), script: fwd(SCRIPT) });
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
