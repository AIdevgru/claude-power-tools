// Use case: tests/use-cases/usage-continue.md
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skillFile, skillModule } from "../../scripts/layout.mjs";

const HOME = mkdtempSync(path.join(tmpdir(), "usage-continue-"));
const CFG = mkdtempSync(path.join(tmpdir(), "usage-continue-cfg-"));
process.env.USAGE_HANDOFF_HOME = HOME;
process.env.CLAUDE_CONFIG_DIR = CFG;
const m = await skillModule("usage-handoff", "scripts/usage.mjs");
const SCRIPT = skillFile("usage-handoff", "scripts", "usage.mjs");
const SKILL = readFileSync(skillFile("usage-handoff", "SKILL.md"), "utf8");

const MIN = 60_000;
const T0 = new Date(2026, 10, 10, 15, 47, 0).getTime(); // local time, so cron fields are easy to read
const at = (ms) => new Date(ms).toISOString();
const LEE = { key: "acct-lee/org-1", email: "lee@example.com" };
const WORK = { key: "acct-work/org-2", email: "lee@acme.dev" };
const windows = (five, fiveReset, seven = 40, sevenReset = T0 + 3 * 24 * 60 * MIN) => [
  { name: "five_hour", pct: five, resetsAt: fiveReset },
  { name: "seven_day", pct: seven, resetsAt: sevenReset },
].sort((a, b) => b.pct - a.pct);

test("the restart job runs a minute after the reset in local time, never on :00 or :30 and never in the past", () => {
  const d = m.jobTime(T0 + 30 * MIN, T0); // reset 4:17 PM
  assert.equal(d.getHours(), 16);
  assert.equal(d.getMinutes(), 18);
  assert.equal(m.cronAt(d), `18 16 ${d.getDate()} ${d.getMonth() + 1} *`);
  assert.equal(m.jobTime(new Date(2026, 10, 10, 15, 59, 0).getTime(), T0).getMinutes(), 1, ":00 moves to :01");
  assert.equal(m.jobTime(new Date(2026, 10, 10, 16, 29, 0).getTime(), T0).getMinutes(), 31, ":30 moves to :31");
  assert.ok(m.jobTime(T0 - 60 * MIN, T0).getTime() > T0, "a reset that has passed runs from now");
  const spec = m.jobSpec({ resumeAt: at(T0 + 30 * MIN), sessionId: "aaaa-1111", round: "2026-11-10T20:47:00Z", now: T0 });
  assert.equal(spec.cron, `18 16 ${d.getDate()} ${d.getMonth() + 1} *`);
  assert.match(spec.prompt, /usage-handoff skill with the argument "continue --session-id aaaa-1111 --round 2026-11-10T20:47:00Z"/);
  assert.match(spec.runsAtLocal, /4:18 PM/);
});

test("a handoff counts as written once it has a session name and Next steps", () => {
  const skel = m.skeleton({ sessionId: "aaaa-1111", cwd: "/work/api", resumeAt: T0 + 30 * MIN, now: T0 });
  assert.equal(m.isFilled(skel), false);
  const named = skel.replace("Session: (fill in your session name)", "Session: api");
  assert.equal(m.isFilled(named), false, "a name alone isn't a handoff");
  assert.equal(m.isFilled(named.replace("## Next steps\n", "## Next steps\n1. Finish the invoice test.\n")), true);
  assert.equal(m.sectionText("## Goal\nship\n## Next steps\n\n1. a\n2. b\n\n## Watch out for\nx", "Next steps"), "1. a\n2. b");
});

test("the coordinator waits only for this limit's unwritten handoffs whose session is still open", () => {
  const round = at(T0);
  const h = (sessionid, filled, mtime = T0 + MIN, status = "pending") => ({ sessionid, filled, mtime, status, name: sessionid });
  const open = new Map([["api", 1], ["web", 2], ["old", 3]]);
  const waiting = m.waitingOn({
    state: { round }, open, self: "api",
    handoffs: [h("api", false), h("web", false), h("closed", false), h("done", true), h("old", false, T0 - 2 * 3600_000), h("web2", false, T0 + MIN, "resumed by web")],
  });
  assert.deepEqual(waiting.map((x) => x.sessionid), ["web"]);
});

test("only a definite change of account cancels a restart", () => {
  const state = { account: LEE };
  assert.equal(m.loginChanged(state, WORK), true);
  assert.equal(m.loginChanged(state, { ...LEE, email: "renamed@example.com" }), false, "same account");
  assert.equal(m.loginChanged(state, null), false, "logged out, or a test fixture");
  assert.equal(m.loginChanged(state, undefined), false, "a login still being saved");
  assert.equal(m.loginChanged({}, WORK), false, "no account recorded");
});

test("the restart job expires on another login or an older limit, waits when early, and otherwise continues", () => {
  const state = { phase: "handoff", round: "r1", account: LEE, job: { id: "7f3a", sessionId: "api" }, resumeAt: at(T0 + 30 * MIN) };
  const due = { action: "resume" };
  assert.equal(m.continuePlan({ state, account: LEE, decision: due, sessionId: "api", round: "r1" }).action, "continue");
  const login = m.continuePlan({ state, account: WORK, decision: due, sessionId: "api", round: "r1" });
  assert.equal(login.action, "expired");
  assert.match(login.why, /login changed from lee@example\.com to lee@acme\.dev/);
  assert.match(m.continuePlan({ state, account: LEE, decision: due, sessionId: "api", round: "r0" }).why, /earlier limit/);
  assert.match(m.continuePlan({ state, account: LEE, decision: due, sessionId: "web", round: "r1" }).why, /newer restart job/);
  assert.equal(m.continuePlan({ state, account: LEE, decision: { action: "wait", resumeAt: state.resumeAt }, sessionId: "api", round: "r1" }).action, "early");
  assert.equal(m.continuePlan({ state: { ...state, phase: "watching" }, account: LEE, decision: due, sessionId: "api", round: "r1" }).action, "nothing");
  assert.equal(m.continuePlan({ state: { ...state, phase: "watching" }, account: LEE, decision: due, now: true }).action, "continue", "by hand");
  assert.equal(m.continuePlan({ state: { ...state, phase: "resuming" }, account: LEE, decision: { action: "wait" }, sessionId: "api", round: "r1" }).action, "continue", "a resume that stalled");
  const busy = { ...state, phase: "resuming", resumingSince: at(T0 - 5 * MIN) };
  assert.equal(m.continuePlan({ state: busy, account: LEE, decision: due, sessionId: "api", round: "r1", at: T0 }).action, "nothing", "a restart under way");
  assert.equal(m.continuePlan({ state: busy, account: LEE, decision: due, sessionId: "api", round: "r1", at: T0, claimBy: "waker" }).action, "continue", "the waker's claim can be taken over");
  assert.equal(m.continuePlan({ state: busy, account: WORK, decision: due, sessionId: "api", round: "r1", at: T0 }).action, "nothing", "a login change after the reset cancels nothing");
  const gone = { phase: "watching", expired: { round: "r1", from: "lee@example.com", to: "lee@acme.dev" } };
  assert.match(m.continuePlan({ state: gone, account: WORK, decision: due, sessionId: "api", round: "r1" }).why, /login changed from lee@example.com/, "cancelled earlier by the hook or the waker");
});

test("one session finishes the window, up to finish-at; finishing can be turned off", () => {
  const state = { phase: "handoff", round: "r1", threshold: 95 };
  assert.deepEqual(m.roleFor({ state, windows: windows(96, T0 + 30 * MIN), sessionId: "api", now: T0 }), { role: "finish", finishAt: 99, pct: 96 });
  assert.equal(m.roleFor({ state: { ...state, finishAt: 95 }, windows: windows(96, T0 + 30 * MIN), sessionId: "api", now: T0 }).role, "wait");
  assert.match(m.roleFor({ state, windows: windows(99, T0 + 30 * MIN), sessionId: "api", now: T0 }).why, /already at 99%/);
  assert.match(m.roleFor({ state: { ...state, finisher: { round: "r1", sessionId: "web" } }, windows: windows(96, T0 + 30 * MIN), sessionId: "api", now: T0 }).why, /another session/);
  assert.equal(m.roleFor({ state: { ...state, phase: "watching" }, windows: null, sessionId: "api", now: T0 }).role, "wait");
  assert.match(m.roleFor({ state, windows: null, sessionId: "api", now: T0 }).why, /reading failed/, "no finishing without a reading");
});

test("the finisher and its subagents keep working past the threshold and hear once at finish-at", () => {
  const finisher = { sessionId: "api", finishAt: 99, round: "r1" };
  const w96 = windows(96, T0 + 30 * MIN);
  const w99 = windows(99, T0 + 30 * MIN);
  const plan = (input, w, notified = {}) => m.hookPlan({ input, windows: w, notified, now: T0, finisher });
  assert.equal(plan({ session_id: "api" }, w96), null);
  assert.equal(plan({ session_id: "api", agent_id: "sub-1" }, w96), null);
  const stop = plan({ session_id: "api" }, w99);
  assert.equal(stop.finish, true);
  assert.equal(stop.key, "api:finish");
  assert.equal(plan({ session_id: "api" }, w99, { "api:finish": at(T0 + 30 * MIN) }), null, "told once");
  assert.equal(plan({ session_id: "api", agent_id: "sub-1" }, w99).subagent, true);
  assert.equal(plan({ session_id: "web" }, w96).key, "web:main", "everyone else stops at the threshold");

  const text = m.hookMessage(stop, "/h/api.md");
  assert.match(text, /as far as this session was to go/);
  assert.match(text, /Update your handoff at \/h\/api\.md/);
  assert.match(text, /CronList/);

  // Above the threshold the finisher must see the usage: a failed reading stops it.
  const blind = m.hookPlan({ input: { session_id: "api" }, windows: null, now: T0, finisher: { ...finisher, resumeAt: at(T0 + 30 * MIN) } });
  assert.equal(blind.finish, true);
  assert.equal(blind.resumeAt, Date.parse(at(T0 + 30 * MIN)));
  assert.match(m.hookMessage(blind, "/h/api.md"), /usage reading failed.*Stop now/s);
  assert.equal(m.hookPlan({ input: { session_id: "web" }, windows: null, now: T0, finisher }), null, "everyone else is already stopped");
  const passed = { ...finisher, resumeAt: at(T0 - MIN) };
  assert.equal(m.hookPlan({ input: { session_id: "api" }, windows: null, now: T0, finisher: passed }), null, "after the reset there's room again");

  // The weekly window moved the round's reset: the 5-hour window at 99% doesn't change the time the note gives.
  const week = T0 + 3 * 24 * 60 * MIN;
  const late = m.hookPlan({ input: { session_id: "api" }, windows: w99, notified: {}, now: T0, finisher: { ...finisher, resumeAt: at(week) } });
  assert.equal(late.resumeAt, Date.parse(at(week)));
});

test("the coordinator's note adds the wait, the job and the finish; everyone else's ends the turn", () => {
  const plan = { pct: 96, window: "five_hour", resumeAt: T0 + 30 * MIN, subagent: false };
  const coord = m.hookMessage(plan, "/h/api.md", { coordinator: true, sessionId: "aaaa-1111", finishAt: 99, script: "/skills/usage-handoff/scripts/usage.mjs" });
  assert.match(coord, /Wrap up before it runs out/);
  assert.match(coord, /node "\/skills\/usage-handoff\/scripts\/usage\.mjs" await-handoffs --session-id aaaa-1111/);
  assert.match(coord, /CronCreate with its job\.cron, recurring false, and its job\.prompt word for word/);
  assert.match(coord, /job --id <the job id CronCreate returned> --session-id aaaa-1111/);
  assert.match(coord, /role is "finish".*\(at 99%\)/s);
  const plain = m.hookMessage(plan, "/h/web.md");
  assert.doesNotMatch(plain, /await-handoffs|CronCreate/);
  assert.match(plain, /5\. End your turn\. After the reset/);
});

test("a new limit starts a round with its account and coordinator; a later reset moves it, keeping both", () => {
  const first = m.armedState({ phase: "watching", threshold: 95, finishAt: 98, job: { id: "old" }, finisher: { sessionId: "x" } }, { resumeAt: T0 + 30 * MIN, cwd: "/work/api", now: T0, sessionId: "api", account: LEE });
  assert.equal(first.phase, "handoff");
  assert.equal(first.round, at(T0), "to the millisecond, so two limits never share a round");
  assert.deepEqual(first.account, LEE);
  assert.equal(first.coordinator.sessionId, "api");
  assert.equal(first.finishAt, 98);
  assert.equal(first.job, undefined, "an old round's job doesn't carry over");
  assert.equal(first.finisher, undefined);
  const second = m.armedState(first, { resumeAt: T0 + 30 * MIN, cwd: "/work/web", now: T0 + MIN, sessionId: "web", account: WORK });
  assert.equal(second.coordinator.sessionId, "api", "the first session stays the coordinator");
  assert.deepEqual(second.account, LEE);
  const later = m.armedState(second, { resumeAt: T0 + 3 * 24 * 60 * MIN, cwd: "/work/api", now: T0 + 2 * MIN });
  assert.equal(Date.parse(later.resumeAt), T0 + 3 * 24 * 60 * MIN);
  assert.equal(later.round, first.round);
  assert.equal(m.armedState(later, { resumeAt: Date.parse(later.resumeAt) + 943, cwd: "/work/api", now: T0 + 3 * MIN }), later, "a fraction of a second isn't a new reset");
});

test("a new limit starts a fresh round even if the last restart stalled, or its reset has passed", () => {
  assert.equal(m.freshRound({ phase: "watching" }, T0), true);
  assert.equal(m.freshRound({ phase: "resuming", round: "r1" }, T0), true, "the resume session stopped early");
  assert.equal(m.freshRound({ phase: "handoff", resumeAt: at(T0 - MIN) }, T0), true, "its reset has passed");
  assert.equal(m.freshRound({ phase: "handoff", resumeAt: at(T0 + MIN) }, T0), false);
  const stuck = { phase: "resuming", round: "r1", coordinator: { sessionId: "old" }, finisher: { round: "r1" }, job: { id: "j" }, account: WORK, resumingSince: at(T0 - 3600_000) };
  const next = m.armedState(stuck, { resumeAt: T0 + 30 * MIN, cwd: "/work/api", now: T0, sessionId: "api", account: LEE });
  assert.equal(next.phase, "handoff");
  assert.equal(next.coordinator.sessionId, "api");
  assert.deepEqual(next.account, LEE);
  assert.equal(next.job, undefined);
  assert.equal(next.finisher, undefined);

  // Resumed by hand before the reset, with the window still full: the same limit, not a new one.
  const byHand = { phase: "resuming", round: "r1", resumeAt: at(T0 + 30 * MIN), resumingSince: at(T0 - MIN) };
  assert.equal(m.freshRound(byHand, T0, T0 + 30 * MIN + 943), false);
  assert.equal(m.armedState(byHand, { resumeAt: T0 + 30 * MIN + 943, cwd: "/w", now: T0 }).phase, "resuming");
  assert.equal(m.freshRound(byHand, T0, T0 + 3 * 24 * 60 * MIN), true, "a different reset is a new limit");
  const waiting = { phase: "handoff", round: "r1", resumeAt: at(T0 + 30 * MIN) };
  assert.equal(m.armedState(waiting, { resumeAt: T0 - MIN, cwd: "/w", now: T0 }), waiting, "a reset that has passed starts nothing");
});

test("the reset moves only for a known reset more than a minute later", () => {
  const cur = at(T0 + 30 * MIN);
  assert.equal(m.movedReset(windows(96, T0 + 30 * MIN + 943), 95, cur, T0), null, "a fraction of a second");
  assert.equal(m.movedReset([{ name: "five_hour", pct: 96, resetsAt: null }], 95, cur, T0), null, "no reset time is a guess, not a move");
  assert.equal(m.movedReset(windows(96, T0 + 30 * MIN, 96, T0 + 3 * 24 * 60 * MIN), 95, cur, T0), T0 + 3 * 24 * 60 * MIN);
  assert.equal(m.movedReset(windows(50, T0 + 30 * MIN, 40), 95, cur, T0), null, "nothing hot");
});

test("the cache re-reads every 30 seconds above the threshold, where only the finisher still works", () => {
  assert.equal(m.cacheTtlMs(96), 30_000);
  assert.equal(m.cacheTtlMs(90), 60_000);
});

// ---- end to end, through the CLI and the hook, with made-up usage and sessions ----

const FIXTURE = path.join(HOME, "usage.json");
const usage = (five, fiveReset) => writeFileSync(FIXTURE, JSON.stringify({
  five_hour: { utilization: five, resets_at: at(fiveReset) },
  seven_day: { utilization: 40, resets_at: at(fiveReset + 3 * 24 * 60 * MIN) },
}));
const env = (account = LEE) => ({ ...process.env, USAGE_HANDOFF_HOME: HOME, CLAUDE_CONFIG_DIR: CFG, USAGE_HANDOFF_FIXTURE: FIXTURE, USAGE_HANDOFF_ACCOUNT: JSON.stringify(account), USAGE_HANDOFF_DRY_LAUNCH: "1", USAGE_HANDOFF_AWAIT_S: "2" });
const cli = (args, account) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: env(account) });
const json = (args, account) => JSON.parse(cli(args, account).stdout);
const hook = (input, account) => {
  rmSync(path.join(HOME, "usage-cache.json"), { force: true });
  const out = execFileSync(process.execPath, [SCRIPT, "--hook"], { encoding: "utf8", input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", cwd: HOME, ...input }), env: env(account) });
  return out ? JSON.parse(out).hookSpecificOutput.additionalContext : "";
};
const state = () => JSON.parse(readFileSync(path.join(HOME, "state.json"), "utf8"));
const killWaker = () => { try { process.kill(state().waker.pid); } catch {} };
// Sessions "open" for openSessions(): Claude Code's session files, with a live pid (this one).
function openSession(id) {
  mkdirSync(path.join(CFG, "sessions"), { recursive: true });
  writeFileSync(path.join(CFG, "sessions", `${id}.json`), JSON.stringify({ sessionId: id, pid: process.pid }));
}
function fill(sessionId, name) {
  const file = path.join(HOME, "handoffs", `${m.handoffSlug(HOME, sessionId)}.md`);
  const text = readFileSync(file, "utf8").replace("Session: (fill in your session name)", `Session: ${name}`).replace("## Next steps\n", "## Next steps\n1. Carry on.\n");
  writeFileSync(file, text);
  return file;
}

test("end to end: coordinate, wait for the handoffs, finish to 99%, schedule the job, and continue at the reset", () => {
  const API = "aaaa1111-api";
  const WEB = "bbbb2222-web";
  openSession(API);
  openSession(WEB);
  cli(["reset"]);
  rmSync(path.join(HOME, "notified.json"), { force: true });
  usage(96, Date.now() + 40 * MIN);
  try {
    const apiNote = hook({ session_id: API });
    assert.match(apiNote, /You coordinate this limit/);
    assert.match(apiNote, new RegExp(`await-handoffs --session-id ${API}`));
    const webNote = hook({ session_id: WEB });
    assert.match(webNote, /Wrap up/);
    assert.doesNotMatch(webNote, /coordinate/);
    assert.deepEqual(state().account, LEE);

    // The coordinator must write its own handoff first.
    const early = cli(["await-handoffs", "--session-id", API]);
    assert.equal(early.status, 4);
    assert.match(early.stdout, /write your handoff first/);

    // web hasn't written yet: the wait times out (2 s here) and names it; api still finishes.
    fill(API, "api");
    const timedOut = json(["await-handoffs", "--session-id", API]);
    assert.equal(timedOut.timedOut, true);
    assert.deepEqual(timedOut.waitingOn, [`${m.handoffSlug(HOME, WEB)}`]);
    assert.equal(timedOut.role, "finish");
    fill(WEB, "web");
    const done = json(["await-handoffs", "--session-id", API]);
    assert.equal(done.timedOut, undefined);
    assert.equal(done.written, 2);
    assert.equal(done.role, "finish", "the same session asking again keeps the role");
    assert.match(done.job.cron, /^\d+ \d+ \d+ \d+ \*$/);
    assert.match(done.job.prompt, new RegExp(`continue --session-id ${API} --round ${state().round}`));
    assert.equal(json(["await-handoffs", "--session-id", WEB]).role, "wait", "one finisher per limit");

    const rec = json(["job", "--id", "7f3a", "--session-id", API]);
    assert.equal(rec.job.email, "lee@example.com");
    assert.equal(json(["check"]).job.id, "7f3a");

    // The finisher works on at 97%, and hears once at 99%.
    usage(97, Date.parse(state().resumeAt));
    assert.equal(hook({ session_id: API }), "");
    usage(99, Date.parse(state().resumeAt));
    assert.match(hook({ session_id: API }), /Stop now/);
    assert.equal(hook({ session_id: API }), "");

    // The job runs early: it gets a new time, never in the past.
    const tooSoon = json(["continue", "--session-id", API, "--round", state().round, "--by", "api"]);
    assert.equal(tooSoon.action, "early");
    assert.ok(Date.parse(tooSoon.job.runsAt) > Date.now());

    // The weekly window fills too: the reset moves, and the job's session is told to move the job.
    const week = Date.now() + 2 * 24 * 60 * MIN;
    writeFileSync(FIXTURE, JSON.stringify({ five_hour: { utilization: 99, resets_at: at(Date.parse(state().resumeAt)) }, seven_day: { utilization: 96, resets_at: at(week) } }));
    const moved = hook({ session_id: API });
    assert.match(moved, /moved to .*CronDelete 7f3a/s);
    assert.equal(Date.parse(state().resumeAt), Math.floor(week / 1000) * 1000);
    assert.equal(hook({ session_id: API }), "", "told once per new time");

    // The reset: usage is low again and the time has passed. The job continues everyone, once.
    killWaker();
    usage(3, Date.now() + 5 * 60 * MIN);
    writeFileSync(path.join(HOME, "state.json"), JSON.stringify({ ...state(), resumeAt: at(Date.now() - MIN), waker: null }));
    const go = json(["continue", "--session-id", API, "--round", state().round, "--by", "api"]);
    assert.equal(go.action, "continue");
    assert.deepEqual(go.pending.map((p) => p.session).sort(), ["api", "web"]);
    assert.equal(go.pending.every((p) => p.open), true);
    const again = json(["continue", "--session-id", API, "--round", state().round, "--by", "waker-session"]);
    assert.equal(again.action, "nothing", "a restart already under way isn't started twice");
    assert.match(again.why, /already being restarted/);
    cli(["finish-resume"]);
    const after = state();
    assert.equal(after.phase, "watching");
    assert.equal(after.job, undefined);
    assert.equal(after.finisher, undefined);
    assert.equal(after.coordinator, undefined);
  } finally {
    killWaker();
    cli(["reset"]);
  }
});

test("end to end: another login cancels the restart, for the hook, the job and the waker", () => {
  const API = "cccc3333-api";
  openSession(API);
  cli(["reset"]);
  rmSync(path.join(HOME, "notified.json"), { force: true });
  rmSync(path.join(HOME, "handoffs"), { recursive: true, force: true });
  usage(96, Date.now() + 40 * MIN);
  try {
    hook({ session_id: API });
    fill(API, "api");
    json(["job", "--id", "9b2c", "--session-id", API]);
    const round = state().round;

    // Same account with a renewed token: nothing changes.
    assert.equal(hook({ session_id: API }), "");
    assert.equal(state().phase, "handoff");

    // Lee logs in to the work account. The next hook call cancels the round and says how to restart.
    const note = hook({ session_id: API }, WORK);
    assert.match(note, /login changed from lee@example\.com to lee@acme\.dev/);
    assert.match(note, /CronDelete 9b2c/);
    assert.match(note, /1 handoff\(s\) are still pending; \/usage-handoff resume/);
    assert.equal(state().phase, "watching");
    assert.equal(state().expired.job.id, "9b2c");

    // The job, when it runs, finds its round was cancelled.
    const cancelled = json(["continue", "--session-id", API, "--round", round, "--by", "api"], WORK);
    assert.equal(cancelled.action, "expired");
    assert.match(cancelled.why, /login changed from lee@example.com to lee@acme.dev/);

    // If the job runs before any hook noticed, it expires the round itself.
    usage(96, Date.now() + 40 * MIN);
    hook({ session_id: "dddd4444-web" });
    json(["job", "--id", "1d4e", "--session-id", "dddd4444-web"]);
    const r2 = state().round;
    const exp = json(["continue", "--session-id", "dddd4444-web", "--round", r2, "--by", "web"], WORK);
    assert.equal(exp.action, "expired");
    assert.equal(state().phase, "watching");
    // The job that just fired isn't one to delete.
    const told = hook({ session_id: "dddd4444-web" }, WORK);
    assert.match(told, /login changed/);
    assert.doesNotMatch(told, /CronDelete/);
  } finally {
    killWaker();
    cli(["reset"]);
  }
});

test("end to end: after a login change the new account's limit is handled, and an old job leaves the new one alone", () => {
  const API = "eeee5555-api";
  openSession(API);
  cli(["reset"]);
  rmSync(path.join(HOME, "notified.json"), { force: true });
  rmSync(path.join(HOME, "handoffs"), { recursive: true, force: true });
  usage(96, Date.now() + 40 * MIN);
  try {
    assert.match(hook({ session_id: API }), /You coordinate this limit/);
    fill(API, "api");
    json(["job", "--id", "j1", "--session-id", API]);
    const r1 = state().round;

    // Lee switches to the work account, which has room. A subagent's hook notices first: the round
    // ends, and the parent hears about it on its next call.
    usage(10, Date.now() + 4 * 60 * MIN);
    assert.equal(hook({ session_id: API, agent_id: "sub-1" }, WORK), "");
    assert.equal(state().phase, "watching");
    const note = hook({ session_id: API }, WORK);
    assert.match(note, /login changed from lee@example.com to lee@acme.dev/);
    assert.match(note, /CronDelete j1/);
    assert.equal(hook({ session_id: API }, WORK), "", "told once");

    // The work account reaches its limit too: the session that was told about the first limit is
    // told about this one, and coordinates it.
    usage(97, Date.now() + 2 * 60 * MIN);
    const again = hook({ session_id: API }, WORK);
    assert.match(again, /Wrap up before it runs out/);
    assert.match(again, /You coordinate this limit/);
    assert.deepEqual(state().account, WORK);
    assert.notEqual(state().round, r1);
    json(["job", "--id", "j2", "--session-id", API], WORK);

    // The first job fires at the old account's reset. It's stale, and the new job stays recorded.
    const old = json(["continue", "--session-id", API, "--round", r1, "--by", "api"], WORK);
    assert.equal(old.action, "expired");
    assert.equal(state().job.id, "j2");
    assert.equal(state().phase, "handoff");
  } finally {
    killWaker();
    cli(["reset"]);
  }
});

test("end to end: hook calls don't rewrite the state when nothing moved, and mark-handoff starts a clean round", () => {
  const API = "ffff6666-api";
  const WEB = "gggg7777-web";
  openSession(API);
  openSession(WEB);
  cli(["reset"]);
  rmSync(path.join(HOME, "notified.json"), { force: true });
  // The endpoint gives reset times with microseconds.
  const reset = new Date(Date.now() + 40 * MIN).toISOString().replace(/\.\d+Z$/, ".943648+00:00");
  writeFileSync(FIXTURE, JSON.stringify({ five_hour: { utilization: 96, resets_at: reset }, seven_day: { utilization: 40, resets_at: at(Date.now() + 3 * 24 * 60 * MIN) } }));
  try {
    hook({ session_id: API });
    const first = state();
    hook({ session_id: WEB });
    hook({ session_id: API });
    hook({ session_id: API, agent_id: "sub-1" });
    const after = state();
    assert.equal(after.requestedAt, first.requestedAt);
    assert.equal(after.waker.pid, first.waker.pid, "one waker");
    assert.equal(after.round, first.round);
    killWaker();

    // The /loop path: a round left over from before doesn't leak into the next limit.
    writeFileSync(path.join(HOME, "state.json"), JSON.stringify({ phase: "watching", threshold: 95, round: "old", job: { id: "old" }, finisher: { sessionId: WEB, round: "old" }, account: WORK, coordinator: { sessionId: WEB } }));
    const resumeAt = at(Date.now() + 40 * MIN);
    cli(["mark-handoff", "--resume-at", resumeAt, "--session", "watcher", "--cwd", HOME, "--no-waker"]);
    const marked = state();
    assert.equal(marked.phase, "handoff");
    assert.notEqual(marked.round, "old");
    assert.ok(Date.parse(marked.round) > 0);
    assert.equal(marked.job, undefined);
    assert.equal(marked.finisher, undefined);
    assert.equal(marked.coordinator, undefined);
    assert.deepEqual(marked.account, LEE);

    // job records the time actually scheduled when it's given one.
    const runsAt = at(Date.now() + 90 * MIN).replace(/\.\d+Z$/, "Z");
    assert.equal(json(["job", "--id", "j3", "--session-id", API, "--runs-at", runsAt]).job.runsAt, runsAt);

    // A resume that finishes after a new limit started leaves that limit waiting.
    assert.match(cli(["finish-resume"]).stdout, /still waiting/);
    assert.equal(state().phase, "handoff");
  } finally {
    killWaker();
    cli(["reset"]);
  }
});

test("end to end: sessions crossing the threshold at the same moment get one coordinator", async () => {
  const ids = ["hhhh0001-a", "hhhh0002-b", "hhhh0003-c", "hhhh0004-d"];
  for (const id of ids) openSession(id);
  cli(["reset"]);
  rmSync(path.join(HOME, "notified.json"), { force: true });
  rmSync(path.join(HOME, "usage-cache.json"), { force: true });
  usage(96, Date.now() + 40 * MIN);
  const run = (id) => new Promise((resolve) => {
    const c = spawn(process.execPath, [SCRIPT, "--hook"], { env: env() });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.on("close", () => resolve(out ? JSON.parse(out).hookSpecificOutput.additionalContext : ""));
    c.stdin.end(JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", cwd: HOME, session_id: id }));
  });
  try {
    const notes = await Promise.all(ids.map(run));
    assert.equal(notes.filter((n) => /Wrap up/.test(n)).length, 4, "everyone is told");
    const coords = ids.filter((id, i) => /You coordinate this limit/.test(notes[i]));
    assert.equal(coords.length, 1, `one coordinator (${coords.join(", ")})`);
    assert.equal(state().coordinator.sessionId, coords[0], "the state names the same one");
  } finally {
    killWaker();
    cli(["reset"]);
  }
});

test("the skill restarts everyone, not just the sessions with handoffs, and documents the job", () => {
  assert.match(SKILL, /Everyone continues/);
  assert.match(SKILL, /If you stopped because of the usage limit, carry on where you left off/);
  assert.match(SKILL, /## Continue \(the restart job\)/);
  for (const action of ["expired", "nothing", "early", "claimed", "continue"]) assert.match(SKILL, new RegExp(`\\*\\*\`${action}\`\\*\\*`), action);
  assert.match(SKILL, /--finish-at N/);
  assert.match(SKILL, /Locked to the login/);
  assert.match(SKILL, /^allowed-tools:.*CronCreate, CronDelete, CronList/m);
});
