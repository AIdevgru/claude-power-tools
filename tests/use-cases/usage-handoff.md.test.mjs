// Use case: tests/use-cases/usage-handoff.md
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skillFile, skillModule } from "../../scripts/layout.mjs";

const HOME = mkdtempSync(path.join(tmpdir(), "usage-handoff-"));
process.env.USAGE_HANDOFF_HOME = HOME;
// Readings are filed under the logged-in account: keep the real login out of these tests.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "usage-handoff-cfg-"));
const {
  MESSAGED_STALE_MS, STALE_CLAIM_MS, cacheTtlMs, cachedWindows, claimResume, decide, handoffSlug, hasTranscript,
  hookEnabled, hookMessage, hookPlan, isPending, launchCommand, listHandoffs, localTime, markResumed, openSessions, pace,
  parseHandoff, parseWindows, resolveClaude, RESUMER_TOOLS, resumerCommand, resumePrompt, skeleton, stalePending,
} = await skillModule("usage-handoff", "scripts/usage.mjs");
const mod = await skillModule("usage-handoff", "scripts/usage.mjs");

const SCRIPT = skillFile("usage-handoff", "scripts", "usage.mjs");
const T0 = Date.UTC(2026, 10, 1, 20, 0, 0);
const MIN = 60_000;
const at = (ms) => new Date(ms).toISOString();
const usage = (five, seven = 10, fiveReset = T0 + 30 * MIN, sevenReset = T0 + 3 * 24 * 60 * MIN) => ({
  five_hour: { utilization: five, resets_at: at(fiveReset) },
  seven_day: { utilization: seven, resets_at: at(sevenReset) },
  seven_day_opus: null,
  extra_usage: { is_enabled: true, utilization: 99 },
});

function cli(args, env = {}) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, USAGE_HANDOFF_HOME: HOME, ...env } });
}

function handoff(name, status = "pending", cwd = HOME) {
  mkdirSync(path.join(HOME, "handoffs"), { recursive: true });
  const file = path.join(HOME, "handoffs", `${name}.md`);
  writeFileSync(file, `# Handoff\nStatus: ${status}\nSession: ${name}\nCwd: ${cwd}\nBranch: feat/${name}\nPR: #12\n\n## Next steps\n1. x\n`);
  return file.replace(/\\/g, "/");
}

test("ticks check back less often the further usage is from the threshold; extra credits aren't a window", () => {
  assert.deepEqual([40, 60, 80, 85, 92].map((p) => pace(p)), [3600, 1800, 900, 300, 120]);
  const w = parseWindows(usage(64, 49));
  assert.deepEqual(w.map((x) => x.name), ["five_hour", "seven_day"]);
  assert.equal(decide({ windows: w, now: T0 }).action, "watch");
});

test("at 96% the tick asks for handoffs and waits until just after the reset", () => {
  const d = decide({ windows: parseWindows(usage(96)), now: T0 });
  assert.equal(d.action, "handoff");
  assert.deepEqual(d.hot, ["five_hour"]);
  assert.equal(Date.parse(d.resumeAt), T0 + 30 * MIN);
  assert.equal(d.nextCheckSeconds, 30 * 60 + 60);
  // --threshold moves the trigger.
  assert.equal(decide({ windows: parseWindows(usage(96)), now: T0, threshold: 98 }).action, "watch");
});

test("after handing off, ticks wait without re-asking; a weekly window filling up moves the wait", () => {
  const state = { phase: "handoff", resumeAt: at(T0 + 30 * MIN) };
  const d = decide({ windows: parseWindows(usage(99)), state, now: T0 + 5 * MIN });
  assert.equal(d.action, "wait");
  const far = T0 + 2 * 24 * 60 * MIN;
  const weekly = decide({ windows: parseWindows(usage(99, 97, T0 + 30 * MIN, far)), state, now: T0 + 5 * MIN });
  assert.equal(weekly.action, "wait");
  assert.equal(Date.parse(weekly.resumeAt), far);
  assert.equal(weekly.nextCheckSeconds, 3600, "ScheduleWakeup's ceiling");
});

test("once the window resets the tick resumes; a stale high reading keeps it waiting a little", () => {
  const state = { phase: "handoff", resumeAt: at(T0) };
  assert.equal(decide({ windows: parseWindows(usage(3)), state, now: T0 + MIN }).action, "resume");
  assert.equal(decide({ windows: parseWindows(usage(97, 10, T0 - MIN)), state, now: T0 + MIN }).nextCheckSeconds, 300);
  // With no reading at all, the reset time alone is enough.
  assert.equal(decide({ windows: null, state, now: T0 + MIN }).action, "resume");
});

test("an unreadable usage endpoint is reported, never guessed", () => {
  const d = decide({ windows: null, now: T0 });
  assert.equal(d.action, "unknown");
  assert.equal(d.pct, null);
  const out = JSON.parse(cli(["check"], { USAGE_HANDOFF_CMD: `"${process.execPath}" -e "process.exit(1)"` }));
  assert.equal(out.action, "unknown");
  assert.ok(out.error);
});

test("handoff files are read from their header lines and marked resumed in place", () => {
  const a = handoff("peer-a");
  handoff("peer-b", "resumed by peer-b at 2026-11-01T21:00:00Z");
  const pending = listHandoffs().filter(isPending);
  assert.deepEqual(pending.map((h) => [h.session, h.branch, h.pr]), [["peer-a", "feat/peer-a", "#12"]]);
  markResumed(a, "new $1 session", T0);
  assert.match(readFileSync(a, "utf8"), /^Status: resumed by new \$1 session at 2026-11-01T20:00:00Z$/m);
  assert.equal(listHandoffs().filter(isPending).length, 0);
});

test("only one session resumes per reset; the waker's claim hands over to the session it starts", () => {
  const state = { resumeAt: at(T0) };
  assert.equal(claimResume("waker", state, T0).claimed, true);
  assert.equal(claimResume("waker", state, T0 + MIN).claimed, false, "a second waker never starts a second resume session");
  const taken = claimResume("resumer-1", state, T0 + 2 * MIN);
  assert.deepEqual([taken.claimed, taken.tookOverFrom], [true, "waker"]);
  assert.deepEqual(claimResume("watcher", state, T0 + 3 * MIN), { claimed: false, by: "resumer-1" });
  assert.equal(claimResume("waker", state, T0 + 3 * MIN).claimed, false);
  assert.equal(claimResume("watcher", state, T0 + 3 * MIN + STALE_CLAIM_MS).claimed, true, "a stuck claim expires");
});

test("a live session told to resume that never picks up is relaunched after 15 minutes", () => {
  const c = handoff("peer-c");
  const state = { messaged: { [c]: T0 } };
  const all = listHandoffs();
  assert.deepEqual(stalePending(state, all, T0 + 5 * MIN), []);
  assert.deepEqual(stalePending(state, all, T0 + MESSAGED_STALE_MS + MIN), [c]);
});

test("closed sessions reopen in a new terminal in the handoff's folder, on every platform", () => {
  const prompt = resumePrompt("C:/h/peer a.md");
  assert.doesNotMatch(prompt, /["`$;&|<>^%!]/, "safe for cmd, wt and sh quoting");
  const none = () => false;
  const claude = "claude";
  const win = launchCommand({ platform: "win32", cwd: "C:/work/repo a", prompt, has: none, claude });
  assert.equal(win.cmd, "cmd.exe");
  assert.match(win.args[0], /^\/c start "claude resume" \/D "C:\\work\\repo a" cmd \/c call "claude" "Resume from/);
  const wt = launchCommand({ platform: "win32", cwd: "C:/work/repo", prompt, has: (n) => n === "wt.exe", claude });
  assert.deepEqual(wt.args.slice(0, 8), ["-w", "new", "-d", "C:\\work\\repo", "cmd", "/c", "call", "claude"]);
  const mac = launchCommand({ platform: "darwin", cwd: "/Users/lee/it's", prompt, has: none, claude });
  assert.equal(mac.cmd, "osascript");
  assert.match(mac.args[1], /^tell application "Terminal" to do script "cd '\/Users\/lee\/it'\\\\''s' && 'claude' 'Resume/);
  const linux = launchCommand({ platform: "linux", cwd: "/w", prompt, has: (n) => n === "gnome-terminal", claude });
  assert.deepEqual(linux.args.slice(0, 3), ["--", "bash", "-lc"]);
  assert.equal(launchCommand({ platform: "linux", cwd: "/w", prompt, has: none, claude }), null);
});

test("end to end: 97% asks for handoffs, the waker wakes after the reset and starts the resume", async () => {
  const fixture = path.join(HOME, "usage.json");
  writeFileSync(fixture, JSON.stringify(usage(97, 20, Date.now() + 20 * MIN)));
  const env = { USAGE_HANDOFF_FIXTURE: fixture, USAGE_HANDOFF_DRY_LAUNCH: "1" };
  cli(["reset"], env);
  const check = JSON.parse(cli(["check"], env));
  assert.equal(check.action, "handoff");
  assert.equal(check.handoffDir, path.join(HOME, "handoffs").replace(/\\/g, "/"));

  // One session is still waiting to resume.
  rmSync(path.join(HOME, "handoffs"), { recursive: true, force: true });
  handoff("e2e-peer");
  // Pretend the reset was five minutes ago and usage is low again.
  writeFileSync(fixture, JSON.stringify(usage(2)));
  const marked = JSON.parse(cli(["mark-handoff", "--resume-at", at(Date.now() - 5 * MIN), "--session", "watcher", "--cwd", HOME], env));
  assert.equal(marked.phase, "handoff");
  assert.ok(marked.waker.pid > 0);

  const log = path.join(HOME, "waker.log");
  for (let i = 0; i < 60 && !(existsSync(log) && /started a hidden resume session/.test(readFileSync(log, "utf8"))); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.match(readFileSync(log, "utf8"), /started a hidden resume session for 1 handoff\(s\) in .*claude\S* -p /);
  assert.equal(JSON.parse(cli(["status"], env)).phase, "resuming");
  // The session the waker started takes over the claim, resumes and goes back to watching.
  assert.match(cli(["claim-resume", "--by", "resumer"], env), /"tookOverFrom": "waker"/);
  cli(["finish-resume"], env);
  assert.equal(JSON.parse(cli(["check"], env)).action, "watch");
});

// ---- the hook ----

test("the hook re-reads usage every 10 minutes when low and every minute near the threshold, shared by all sessions", async () => {
  assert.deepEqual([50, 75, 85, 99, null].map((p) => cacheTtlMs(p) / MIN), [10, 5, 1, 1, 10]);
  rmSync(path.join(HOME, "usage-cache.json"), { force: true });
  let reads = 0;
  const read = async () => ((reads += 1), { windows: parseWindows(usage(80)) }); // 80%: a 5-minute cache
  assert.equal((await cachedWindows(T0, 95, read)).cached, false);
  assert.equal((await cachedWindows(T0 + 2 * MIN, 95, read)).cached, true, "another session inside 5 minutes uses the cache");
  await cachedWindows(T0 + 6 * MIN, 95, read);
  assert.equal(reads, 2);
  assert.equal((await cachedWindows(T0 + 6 * MIN + 1000, 95, read, true)).cached, false, "a /usage-handoff tick always reads");
  rmSync(path.join(HOME, "usage-cache.json"), { force: true });
});

test("logging in reads usage again at once, for the hooks and the status line", async () => {
  const { loginStamp, statusCache, statusText } = mod;
  // The stamp is a short hash of the saved token: it changes with the login, and never holds the token.
  const dir = mkdtempSync(path.join(tmpdir(), "usage-login-"));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const login = (token) => writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token } }));
    login("sk-ant-oat-first");
    const first = loginStamp({});
    assert.match(first, /^[0-9a-f]{12}$/);
    assert.ok(!"sk-ant-oat-first".includes(first));
    assert.equal(loginStamp({}), first);
    login("sk-ant-oat-second");
    assert.notEqual(loginStamp({}), first, "a new login (or a renewed token) changes the stamp");
    if (process.platform !== "darwin") { // macOS falls back to the keychain
      rmSync(path.join(dir, ".credentials.json"));
      assert.equal(loginStamp({}), "none");
    }
    assert.equal(loginStamp({ USAGE_HANDOFF_FIXTURE: "x.json" }), null, "fixtures and commands have no login");
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }

  // Logged out: the reading fails and is cached for 10 minutes. Logging in doesn't wait that out.
  rmSync(path.join(HOME, "usage-cache.json"), { force: true });
  let reads = 0;
  const loggedOut = async () => ((reads += 1), { windows: null, error: "not logged in with a Claude subscription (no OAuth token)" });
  const loggedIn = async () => ((reads += 1), { windows: parseWindows(usage(40)) });
  assert.equal((await cachedWindows(T0, 95, loggedOut, false, "none")).windows, null);
  assert.equal((await cachedWindows(T0 + MIN, 95, loggedIn, false, "none")).cached, true, "same login: the cache holds");
  const after = await cachedWindows(T0 + 2 * MIN, 95, loggedIn, false, "abc123def456");
  assert.equal(after.cached, false, "a new login reads again before the 10 minutes are up");
  assert.equal(after.windows[0].pct, 40);
  assert.equal(JSON.parse(readFileSync(path.join(HOME, "usage-cache.json"), "utf8")).login, "abc123def456");
  assert.equal(reads, 2);

  // The status line reads only when the login changed, and then shows the new reading straight away.
  assert.equal((await statusCache({ now: T0 + 3 * MIN, read: loggedOut, login: "abc123def456" })).windows[0].pct, 40);
  assert.equal((await statusCache({ now: T0 + 3 * MIN, read: loggedOut, login: null })).windows[0].pct, 40);
  assert.equal(reads, 2, "same login, or no login to compare: no extra call");
  const out = await statusCache({ now: T0 + 4 * MIN, read: loggedOut, login: "none" });
  assert.equal(reads, 3, "logging out reads again too");
  assert.equal(statusText({ cache: out, now: T0 + 4 * MIN }), "usage: not logged in with a Claude subscription (no OAuth token)");
  rmSync(path.join(HOME, "usage-cache.json"), { force: true });
});

test("the hook tells each session and each subagent once per window, and ignores a reading past its reset", () => {
  const input = { session_id: "abcdef12-3456", cwd: "/w/repo" };
  const hot = parseWindows(usage(97, 10, T0 + 30 * MIN));
  assert.equal(hookPlan({ input, windows: parseWindows(usage(80)), now: T0 }), null);
  const plan = hookPlan({ input, windows: hot, now: T0 });
  assert.deepEqual([plan.key, plan.pct, plan.window, plan.subagent], ["abcdef12-3456:main", 97, "five_hour", false]);
  const told = { [plan.key]: at(plan.resumeAt) };
  assert.equal(hookPlan({ input, windows: hot, now: T0 + MIN, notified: told }), null);
  const sub = hookPlan({ input: { ...input, agent_id: "a7" }, windows: hot, now: T0 + MIN, notified: told });
  assert.equal(sub.subagent, true);
  assert.equal(hookPlan({ input, windows: hot, now: T0 + 31 * MIN }), null, "stale: that window already reset");
  // The next window: an old note doesn't silence a new one.
  assert.ok(hookPlan({ input, windows: parseWindows(usage(97, 10, T0 + 6 * 60 * MIN)), now: T0 + 5 * 60 * MIN, notified: told }));

  const main = hookMessage(plan, "/h/repo-abcdef12.md");
  assert.match(main, /97% of the five-hour limit/);
  assert.match(main, /SendMessage to its id/);
  assert.match(main, /Fill in your handoff at \/h\/repo-abcdef12\.md/);
  assert.match(main, /\/usage-handoff off/);
  assert.match(hookMessage(sub, null), /report for your parent session/);
});

test("the hook's handoff skeleton carries the session id, folder and branch", () => {
  assert.equal(handoffSlug("C:/work/my repo", "ffc29d72-9d35"), "my-repo-ffc29d72");
  const h = parseHandoff(skeleton({ sessionId: "ffc29d72-9d35", cwd: "C:\\work\\repo", branch: "feat/x", resumeAt: T0, now: T0 }));
  assert.deepEqual([h.status, h.sessionid, h.cwd, h.branch, h.resets], ["pending", "ffc29d72-9d35", "C:/work/repo", "feat/x", "2026-11-01T20:00:00Z"]);
});

test("times shown to the owner are in their own time zone, with the date when it isn't today", () => {
  const hhmm = new Date(T0).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).replace(/[\u202f\u00a0]/g, " ");
  assert.match(mod.clockTime(T0), /^\d{1,2}:\d\d (AM|PM) \S+$/, "12-hour with AM or PM and plain spaces");
  assert.equal(localTime(T0, T0), hhmm);
  assert.equal(localTime("2026-11-01T20:00:00Z", T0), hhmm);
  assert.doesNotMatch(localTime(T0, T0), /Z$|T\d/);
  const later = localTime(T0 + 3 * 24 * 60 * MIN, T0);
  assert.match(later, /^\w{3}, \w{3} \d{1,2} \d{1,2}:\d\d (AM|PM) /);
  assert.equal(localTime("not a time"), null);
  // The handoff keeps the UTC value for the script and shows the local time beside it.
  const text = skeleton({ sessionId: "s", cwd: "C:/r", resumeAt: T0, now: T0 });
  assert.ok(text.includes(`Resets: 2026-11-01T20:00:00Z (${hhmm})`));
  assert.equal(parseHandoff("Session: fix (part 2)\nResets: 2026-11-01T20:00:00Z (15:00 EST)").session, "fix (part 2)");
  // The note tells sessions to quote local time.
  const plan = { pct: 96, window: "five_hour", resumeAt: T0, subagent: false };
  const note = hookMessage(plan, "C:/h.md");
  assert.ok(note.includes(`resets ${localTime(T0)}`) && note.includes(`After the reset (${localTime(T0)})`));
  assert.match(note, /not UTC/);
  assert.match(readFileSync(skillFile("usage-handoff", "SKILL.md"), "utf8"), /Show times in the owner's time zone/);
});

test("the hook end to end: one note per session, a waker started, and the off switch", () => {
  const fixture = path.join(HOME, "hook-usage.json");
  writeFileSync(fixture, JSON.stringify(usage(97, 20, Date.now() + 40 * MIN)));
  const env = { USAGE_HANDOFF_FIXTURE: fixture, USAGE_HANDOFF_DRY_LAUNCH: "1" };
  cli(["reset"], env);
  rmSync(path.join(HOME, "usage-cache.json"), { force: true });
  rmSync(path.join(HOME, "notified.json"), { force: true });
  const hook = (input, extra = {}) => execFileSync(process.execPath, [SCRIPT, "--hook"], {
    encoding: "utf8", input: JSON.stringify(input), env: { ...process.env, USAGE_HANDOFF_HOME: HOME, ...env, ...extra },
  });
  const input = { hook_event_name: "PostToolUse", session_id: "11112222-aaaa", cwd: HOME, tool_name: "Bash" };
  try {
    const first = JSON.parse(hook(input));
    assert.equal(first.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(first.hookSpecificOutput.additionalContext, /Wrap up before it runs out/);
    const file = path.join(HOME, "handoffs", `${handoffSlug(HOME, "11112222-aaaa")}.md`);
    assert.equal(parseHandoff(readFileSync(file, "utf8")).sessionid, "11112222-aaaa");
    assert.equal(hook(input), "", "told once");
    assert.match(hook({ ...input, agent_id: "sub-1" }), /report for your parent session/);
    assert.equal(hook({ ...input, hook_event_name: "SessionStart", session_id: "x" }), "", "other events are ignored");
    assert.equal(JSON.parse(cli(["status"], env)).phase, "handoff");

    // The off switch, from the skill and from the environment.
    assert.match(cli(["hook", "off"], env), /hook: off/);
    assert.equal(hook({ ...input, session_id: "33334444-bbbb" }), "");
    assert.equal(hookEnabled({}), false);
    assert.match(cli(["hook", "on"], env), /hook: on/);
    assert.equal(hook({ ...input, session_id: "55556666-cccc" }, { USAGE_HANDOFF_HOOK: "off" }), "");
    assert.match(hook({ ...input, session_id: "77778888-dddd" }), /Wrap up/);

    // After a reboot: the reset has passed and the waker is gone. The next hook call starts one.
    const before = JSON.parse(cli(["status"], env)).waker.pid;
    process.kill(before);
    writeFileSync(fixture, JSON.stringify(usage(3)));
    rmSync(path.join(HOME, "usage-cache.json"), { force: true });
    const st = JSON.parse(readFileSync(path.join(HOME, "state.json"), "utf8"));
    writeFileSync(path.join(HOME, "state.json"), JSON.stringify({ ...st, resumeAt: at(Date.now() - MIN) }));
    assert.equal(hook({ ...input, session_id: "9999aaaa-eeee" }), "");
    const after = JSON.parse(cli(["status"], env)).waker;
    assert.notEqual(after.pid, before);
    assert.equal(after.alive, true);
  } finally {
    const pid = JSON.parse(cli(["status"], env)).waker?.pid;
    if (pid) try { process.kill(pid); } catch {}
    cli(["reset"], env);
  }
});

test("open sessions are messaged, closed ones reopen with claude --resume", () => {
  const cfg = mkdtempSync(path.join(tmpdir(), "usage-handoff-cfg-"));
  mkdirSync(path.join(cfg, "sessions"));
  mkdirSync(path.join(cfg, "projects", "C--work-repo"), { recursive: true });
  writeFileSync(path.join(cfg, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "open-1" }));
  writeFileSync(path.join(cfg, "sessions", "999999.json"), JSON.stringify({ pid: 999999, sessionId: "gone-1" }));
  writeFileSync(path.join(cfg, "projects", "C--work-repo", "gone-1.jsonl"), "{}\n");
  const open = openSessions(path.join(cfg, "sessions"), (pid) => pid === process.pid);
  assert.deepEqual([...open.keys()], ["open-1"]);
  assert.equal(hasTranscript("gone-1", path.join(cfg, "projects")), true);
  assert.equal(hasTranscript("../x", path.join(cfg, "projects")), false);

  const win = launchCommand({ platform: "win32", cwd: "C:/work/repo", prompt: "go", resumeId: "gone-1", has: () => false, claude: "claude" });
  assert.match(win.args[0], /cmd \/c call "claude" --resume gone-1 "go"$/);
  const mac = launchCommand({ platform: "darwin", cwd: "/w", prompt: "go", resumeId: "gone-1", has: () => false, claude: "claude" });
  assert.match(mac.args[1], /'claude' --resume gone-1 'go'/);

  // The CLI: a session that is still open is refused; a closed one is reopened by its id.
  const env = { CLAUDE_CONFIG_DIR: cfg };
  const openFile = path.join(HOME, "handoffs", "open.md");
  writeFileSync(openFile, `Status: pending\nSessionId: open-1\nCwd: ${HOME}\n`);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, "launch", openFile, "--dry-run"], {
    env: { ...process.env, USAGE_HANDOFF_HOME: HOME, ...env }, stdio: "pipe",
  }), /still open/);
  const goneFile = path.join(HOME, "handoffs", "gone.md");
  writeFileSync(goneFile, `Status: pending\nSessionId: gone-1\nCwd: ${HOME}\n`);
  assert.equal(JSON.parse(cli(["launch", goneFile, "--dry-run"], env)).resumed, "gone-1");
  const pending = JSON.parse(cli(["pending"], env)).filter((h) => ["open-1", "gone-1"].includes(h.sessionid));
  assert.deepEqual(pending.map((h) => [h.sessionid, h.open, h.canReopen]).sort(), [["gone-1", false, true], ["open-1", true, false]]);
});

// ---- resuming without extra windows ----

test("the resume session runs hidden with only the tools it needs, and new windows close when claude exits", () => {
  // The usual Windows install is claude.exe: started directly, no shell, no window.
  const exe = resumerCommand({ platform: "win32", claude: "C:\\u\\.local\\bin\\claude.exe" });
  assert.equal(exe.cmd, "C:\\u\\.local\\bin\\claude.exe");
  assert.deepEqual(exe.args, ["-p", exe.args[1], "--allowedTools", RESUMER_TOOLS, "--max-turns", "40"]);
  assert.equal(RESUMER_TOOLS, "Skill,ToolSearch,ListAgents,SendMessage,Read,Bash(node:*),PowerShell(node:*)");
  assert.match(exe.args[1], /^Claude usage has reset\./);
  // An npm .cmd shim needs cmd.exe; `call` keeps the quoted path intact.
  const shim = resumerCommand({ platform: "win32", claude: "C:\\npm\\claude.cmd" });
  assert.equal(shim.cmd, "cmd.exe");
  assert.match(shim.args[0], /^\/d \/c call "C:\\npm\\claude\.cmd" -p "Claude usage has reset\. .*" --allowedTools ".*" --max-turns 40$/);
  assert.equal(resumerCommand({ platform: "linux", claude: "/usr/local/bin/claude" }).cmd, "/usr/local/bin/claude");

  // Windows that do open (closed sessions) end with that claude: no cmd /k or exec bash left behind.
  const prompt = "go";
  const claude = "C:\\u\\claude.exe";
  assert.match(launchCommand({ platform: "win32", cwd: "C:/w", prompt, claude, has: () => false }).args[0], / cmd \/c call "C:\\u\\claude\.exe" "go"$/);
  assert.deepEqual(launchCommand({ platform: "win32", cwd: "C:/w", prompt, claude, has: (n) => n === "wt.exe" }).args.slice(4, 8), ["cmd", "/c", "call", claude]);
  assert.equal(launchCommand({ platform: "linux", cwd: "/w", prompt, claude: "/bin/claude", has: (n) => n === "xterm" }).args.at(-1), "cd '/w' && '/bin/claude' 'go'");
});

test("nothing the waker starts opens a window or takes focus", () => {
  // The waker runs with no console. On Windows, a child started without windowsHide gets a new,
  // visible console window that takes focus, so every process this script starts hides it.
  const src = readFileSync(SCRIPT, "utf8");
  const calls = src.split("\n").filter((l) => /\b(execFileSync|spawn)\(/.test(l) && !/^\s*(\/\/|import)/.test(l));
  assert.ok(calls.length >= 8, `found ${calls.length} process calls`);
  for (const l of calls) assert.match(l, /windowsHide: true|\.\.\.how/, `no windowsHide: ${l.trim()}`);
  // The resume session gets a hidden console of its own (attached, hidden), which the hooks, git
  // and shells it runs share instead of each opening a window. The waker waits for it, because
  // Windows ends an attached child when its parent exits. Elsewhere it's detached as before.
  assert.deepEqual(mod.resumerSpawn("win32"), { detached: false, windowsHide: true, wait: true });
  assert.deepEqual(mod.resumerSpawn("linux"), { detached: true, windowsHide: true, wait: false });
  assert.deepEqual(mod.resumerSpawn("darwin"), { detached: true, windowsHide: true, wait: false });
});

test("claude is found by its full path, not left to a long PATH", () => {
  const none = () => [];
  assert.equal(resolveClaude({ env: { USAGE_HANDOFF_CLAUDE: "/x/claude" } }), "/x/claude");
  assert.equal(resolveClaude({ env: {}, platform: "win32", which: () => ["C:\\npm\\claude.cmd", "C:\\u\\.local\\bin\\claude.exe"] }), "C:\\u\\.local\\bin\\claude.exe", "the .exe beats an npm shim");
  assert.equal(resolveClaude({ env: {}, platform: "win32", which: () => ["C:\\npm\\claude.cmd"] }), "C:\\npm\\claude.cmd");
  const home = "C:\\Users\\lee";
  assert.equal(resolveClaude({ env: { USERPROFILE: home }, platform: "win32", which: none, exists: (p) => p === path.join(home, ".local", "bin", "claude.exe") }), path.join(home, ".local", "bin", "claude.exe"));
  assert.equal(resolveClaude({ env: { HOME: "/home/lee" }, platform: "linux", which: none, exists: () => false }), "claude");
});

function waitForLog(re, ms = 30_000) {
  const log = path.join(HOME, "waker.log");
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(log) && re.test(readFileSync(log, "utf8"))) return true;
    execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 500)"]);
  }
  return false;
}

test("with no pending handoffs the waker starts nothing and goes back to watching", () => {
  const fixture = path.join(HOME, "quiet-usage.json");
  writeFileSync(fixture, JSON.stringify(usage(2)));
  const env = { USAGE_HANDOFF_FIXTURE: fixture, USAGE_HANDOFF_DRY_LAUNCH: "1" };
  cli(["reset"], env);
  rmSync(path.join(HOME, "handoffs"), { recursive: true, force: true });
  rmSync(path.join(HOME, "waker.log"), { force: true });
  cli(["mark-handoff", "--resume-at", at(Date.now() - 5 * MIN), "--session", "watcher", "--cwd", HOME], env);
  assert.ok(waitForLog(/no pending handoffs, nothing to start/), readFileSync(path.join(HOME, "waker.log"), "utf8"));
  assert.doesNotMatch(readFileSync(path.join(HOME, "waker.log"), "utf8"), /started a hidden resume session/);
  assert.equal(JSON.parse(cli(["status"], env)).phase, "watching");
});

test("once a resume is under way, hook calls don't start another waker", () => {
  const fixture = path.join(HOME, "resuming-usage.json");
  writeFileSync(fixture, JSON.stringify(usage(2)));
  const env = { USAGE_HANDOFF_FIXTURE: fixture, USAGE_HANDOFF_DRY_LAUNCH: "1" };
  rmSync(path.join(HOME, "usage-cache.json"), { force: true });
  const base = { phase: "resuming", threshold: 95, resumeAt: at(Date.now() - 5 * MIN), cwd: HOME, waker: { pid: 999999 } };
  const hook = () => execFileSync(process.execPath, [SCRIPT, "--hook"], {
    encoding: "utf8", input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "aaaa1111-x", cwd: HOME }),
    env: { ...process.env, USAGE_HANDOFF_HOME: HOME, ...env },
  });
  writeFileSync(path.join(HOME, "state.json"), JSON.stringify({ ...base, resumingSince: at(Date.now() - MIN) }));
  hook();
  assert.equal(JSON.parse(cli(["status"], env)).waker.pid, 999999, "a fresh resume keeps its claim");
  // A resume stuck for longer than a claim lasts gets a new waker.
  writeFileSync(path.join(HOME, "state.json"), JSON.stringify({ ...base, resumingSince: at(Date.now() - STALE_CLAIM_MS - MIN) }));
  hook();
  const w = JSON.parse(cli(["status"], env)).waker;
  try {
    assert.notEqual(w.pid, 999999);
  } finally {
    try { process.kill(w.pid); } catch {}
    cli(["reset"], env);
  }
});

test("the status line shows each window, the reset in local time, the handoff and an old reading", () => {
  const { statusText } = mod;
  const cache = { at: T0, windows: [{ name: "five_hour", pct: 64.4, resetsAt: T0 + 30 * MIN }, { name: "seven_day", pct: 49, resetsAt: T0 + 3 * 24 * 60 * MIN }] };
  const soon = mod.localTime(T0 + 30 * MIN, T0);
  const later = T0 + 3 * 24 * 60 * MIN;
  const weekday = new Date(later).toLocaleDateString("en-US", { weekday: "short" });
  const laterTime = mod.clockTime(later);
  assert.equal(mod.shortLocalTime(later, T0), `${weekday} ${laterTime}`);
  assert.equal(mod.shortLocalTime(T0 + 30 * MIN, T0), soon);
  assert.equal(mod.shortLocalTime(T0 + 8 * 24 * 60 * MIN, T0), mod.localTime(T0 + 8 * 24 * 60 * MIN, T0), "a week or more away keeps the date");
  const sameWeekdayNextWeek = T0 + (7 * 24 * 60 - 60) * MIN; // under 7 days, but the same weekday as today
  assert.equal(mod.shortLocalTime(sameWeekdayNextWeek, T0), mod.localTime(sameWeekdayNextWeek, T0), "next week's same weekday keeps the date");
  assert.equal(statusText({ cache, now: T0 }), `5h 64% (resets ${soon}) · week 49% (resets ${weekday} ${laterTime})`);
  assert.equal(statusText({ cache, state: { phase: "handoff", resumeAt: "2026-11-01T20:30:00Z" }, now: T0 }), `5h 64% (resets ${soon}) · week 49% (resets ${weekday} ${laterTime}) · handing off, back ${soon}`);
  assert.equal(statusText({ cache: { at: T0, windows: [{ name: "five_hour", pct: 3, resetsAt: T0 - MIN }] }, now: T0 }), "5h 3%", "a passed reset isn't shown");
  const fullerWeek = { at: T0, windows: [{ name: "seven_day", pct: 71 }, { name: "five_hour", pct: 32 }] };
  assert.equal(statusText({ cache: fullerWeek, now: T0 }), "5h 32% · week 71%", "5h always comes first");
  assert.match(statusText({ cache, now: T0 + 20 * MIN }), /· 20 min old$/);
  assert.equal(statusText({ cache: null }), "usage: no reading yet");
});

test("old resume claims are found and removed by reset", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "usage-locks-"));
  writeFileSync(path.join(dir, "resume-2026-11-01T200000Z.lock"), "{}");
  writeFileSync(path.join(dir, "resume-2026-11-02T051000Z.lock"), "{}");
  const names = (state) => mod.staleLocks(state, dir).map((f) => path.basename(f));
  assert.deepEqual(names({ phase: "resuming", resumeAt: "2026-11-02T05:10:00Z" }), ["resume-2026-11-01T200000Z.lock"]);
  assert.equal(names({ phase: "watching" }).length, 2);
  const env = { USAGE_HANDOFF_HOME: dir };
  cli(["reset"], env);
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".lock")), []);
});

test("rehearse plays the whole cycle in a scratch folder and passes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "usage-real-"));
  const outText = cli(["rehearse"], { USAGE_HANDOFF_HOME: dir });
  assert.doesNotMatch(outText, /FAIL/);
  assert.match(outText, /after the reset the waker starts one hidden resume session/);
  assert.match(outText, /only one waker ran \(1\)/);
  assert.match(outText, /rehearsal passed$/m);
  assert.deepEqual(readdirSync(dir), [], "the real state folder is untouched");
});

test("the usage hook skips quick lookups after a tool call but checks everything else", () => {
  const hooks = JSON.parse(readFileSync(path.join(path.dirname(skillFile("usage-handoff", "SKILL.md")), "..", "..", "hooks", "hooks.json"), "utf8"));
  const group = hooks.hooks.PostToolUse.find((g) => g.hooks.some((h) => h.command.includes("usage.mjs")));
  const re = new RegExp(`^(?:${group.matcher})$`);
  for (const t of ["Bash", "PowerShell", "Edit", "Write", "Agent", "Skill", "SendMessage", "mcp__github__create_pr"]) assert.ok(re.test(t), t);
  for (const t of ["Read", "Grep", "Glob", "ToolSearch"]) assert.ok(!re.test(t), t);
  assert.ok(hooks.hooks.UserPromptSubmit.some((g) => !g.matcher && g.hooks.some((h) => h.command.includes("usage.mjs"))));
});

test("a limit that resets before its predicted time resumes then, not at the predicted time", () => {
  const state = { phase: "handoff", resumeAt: new Date(T0 + 120 * MIN).toISOString(), threshold: 95 };
  const rolled = parseWindows(usage(19, 25, T0 + 270 * MIN)); // the 5h window rolled over: new reset, low usage
  assert.equal(mod.resetEarly({ windows: rolled, state, now: T0 }), true);
  const d = decide({ windows: rolled, state, now: T0 });
  assert.equal(d.action, "resume");
  assert.equal(d.early, true);
  // Still the same window (it resets at the predicted time), or still at the threshold: keep waiting.
  assert.equal(mod.resetEarly({ windows: parseWindows(usage(19, 25, T0 + 120 * MIN)), state, now: T0 }), false);
  assert.equal(mod.resetEarly({ windows: parseWindows(usage(96, 25, T0 + 270 * MIN)), state, now: T0 }), false);
  assert.equal(mod.resetEarly({ windows: null, state, now: T0 }), false, "no reading, no guess");
  assert.equal(decide({ windows: parseWindows(usage(96, 25, T0 + 120 * MIN)), state, now: T0 }).action, "wait");
  // The status line says so instead of "handing off, back ...".
  const cache = { at: T0, windows: rolled };
  assert.match(mod.statusText({ cache, state, now: T0 }), /· reset early, resuming$/);
});
