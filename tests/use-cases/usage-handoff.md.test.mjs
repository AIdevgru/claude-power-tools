// Use case: tests/use-cases/usage-handoff.md
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skillFile, skillModule } from "../../scripts/layout.mjs";

const HOME = mkdtempSync(path.join(tmpdir(), "usage-handoff-"));
process.env.USAGE_HANDOFF_HOME = HOME;
const {
  MESSAGED_STALE_MS, STALE_CLAIM_MS, cacheTtlMs, cachedWindows, claimResume, decide, handoffSlug, hasTranscript,
  hookEnabled, hookMessage, hookPlan, isPending, launchCommand, listHandoffs, markResumed, openSessions, pace,
  parseHandoff, parseWindows, resumePrompt, skeleton, stalePending,
} = await skillModule("usage-handoff", "scripts/usage.mjs");

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
  assert.equal(claimResume("waker", state, T0 + MIN).claimed, true, "the same claimer may retry");
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
  const win = launchCommand({ platform: "win32", cwd: "C:/work/repo a", prompt, has: none });
  assert.equal(win.cmd, "cmd.exe");
  assert.match(win.args[0], /^\/c start "claude resume" \/D "C:\\work\\repo a" cmd \/k claude "Resume from/);
  const wt = launchCommand({ platform: "win32", cwd: "C:/work/repo", prompt, has: (n) => n === "wt.exe" });
  assert.deepEqual(wt.args.slice(0, 7), ["-w", "new", "-d", "C:\\work\\repo", "cmd", "/k", "claude"]);
  const mac = launchCommand({ platform: "darwin", cwd: "/Users/lee/it's", prompt, has: none });
  assert.equal(mac.cmd, "osascript");
  assert.match(mac.args[1], /^tell application "Terminal" to do script "cd '\/Users\/lee\/it'\\\\''s' && claude 'Resume/);
  const linux = launchCommand({ platform: "linux", cwd: "/w", prompt, has: (n) => n === "gnome-terminal" });
  assert.deepEqual(linux.args.slice(0, 3), ["--", "bash", "-lc"]);
  assert.equal(launchCommand({ platform: "linux", cwd: "/w", prompt, has: none }), null);
});

test("end to end: 97% asks for handoffs, the waker wakes after the reset and starts the resume", async () => {
  const fixture = path.join(HOME, "usage.json");
  writeFileSync(fixture, JSON.stringify(usage(97, 20, Date.now() + 20 * MIN)));
  const env = { USAGE_HANDOFF_FIXTURE: fixture, USAGE_HANDOFF_DRY_LAUNCH: "1" };
  cli(["reset"], env);
  const check = JSON.parse(cli(["check"], env));
  assert.equal(check.action, "handoff");
  assert.equal(check.handoffDir, path.join(HOME, "handoffs").replace(/\\/g, "/"));

  // Pretend the reset was five minutes ago and usage is low again.
  writeFileSync(fixture, JSON.stringify(usage(2)));
  const marked = JSON.parse(cli(["mark-handoff", "--resume-at", at(Date.now() - 5 * MIN), "--session", "watcher", "--cwd", HOME], env));
  assert.equal(marked.phase, "handoff");
  assert.ok(marked.waker.pid > 0);

  const log = path.join(HOME, "waker.log");
  for (let i = 0; i < 60 && !(existsSync(log) && /started a resume session/.test(readFileSync(log, "utf8"))); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.match(readFileSync(log, "utf8"), /started a resume session in .* claude/);
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

  const win = launchCommand({ platform: "win32", cwd: "C:/work/repo", prompt: "go", resumeId: "gone-1", has: () => false });
  assert.match(win.args[0], /cmd \/k claude --resume gone-1 "go"$/);
  const mac = launchCommand({ platform: "darwin", cwd: "/w", prompt: "go", resumeId: "gone-1", has: () => false });
  assert.match(mac.args[1], /claude --resume gone-1 'go'/);

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
