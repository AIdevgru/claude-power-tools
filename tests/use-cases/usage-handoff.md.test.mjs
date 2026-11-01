// Use case: tests/use-cases/usage-handoff.md
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skillFile, skillModule } from "../../scripts/layout.mjs";

const HOME = mkdtempSync(path.join(tmpdir(), "usage-handoff-"));
process.env.USAGE_HANDOFF_HOME = HOME;
const {
  MESSAGED_STALE_MS, STALE_CLAIM_MS, claimResume, decide, isPending, launchCommand, listHandoffs,
  markResumed, pace, parseWindows, resumePrompt, stalePending,
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
