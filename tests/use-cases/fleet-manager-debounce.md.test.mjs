// Use case: tests/use-cases/fleet-manager-debounce.md
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { skillFile, skillModule } from "../../scripts/layout.mjs";
const {
  BASE_BACKOFF_MS, MAX_BACKOFF_MS, MIN_INTERVAL_MS,
  bypasses, decide, describeChange, hashParts, hookOutput, parseInvocation, stateFile,
} = await skillModule("fleet-manager", "scripts/debounce.mjs");

const SCRIPT = skillFile("fleet-manager", "scripts", "debounce.mjs");
const T0 = Date.UTC(2026, 9, 8, 2, 0, 0);
const MIN = 60_000;
const quietWork = hashParts({ prs: [{ n: 1, head: "a" }], main: { headSha: "m1" }, inbox: [] });
const noFingerprint = () => assert.fail("fingerprint should not be needed");

test("a second /fleet-manager inside 10 minutes is skipped, with a --force hint", () => {
  const ran = decide("", {}, T0, noFingerprint);
  assert.equal(ran.run, true);
  const again = decide("", ran.state, T0 + 2 * MIN, noFingerprint);
  assert.equal(again.run, false);
  assert.match(again.why, /under 10 min ago/);
  const out = hookOutput({ hook_event_name: "UserPromptSubmit" }, again, T0 + 2 * MIN);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /--force/);
});

test("explicit arguments bypass the debounce; once alone does not", () => {
  for (const args of ["--force", "ci", "143", "once ci", "--help", "--deploy auto"]) assert.equal(bypasses(args), true, args);
  for (const args of ["", "once", "  once  "]) assert.equal(bypasses(args), false, args);
  const st = { lastRunAt: T0, status: "running" };
  assert.equal(decide("--force", st, T0 + MIN, noFingerprint).run, true);
  // --help and --deploy run without counting as a tick.
  assert.equal(decide("--help", st, T0 + MIN, noFingerprint).state.lastRunAt, T0);
});

test("quiet work backs off 30 min, doubling to at most 4 h", () => {
  let state = { status: "quiet", recordedAt: T0, fingerprint: quietWork.hash, parts: quietWork.parts, backoffMs: BASE_BACKOFF_MS, nextCheckAt: T0 + BASE_BACKOFF_MS };
  const early = decide("", state, T0 + 20 * MIN, noFingerprint);
  assert.equal(early.run, false);
  assert.match(early.why, /backing off/);

  const waits = [];
  let now = state.nextCheckAt;
  for (let i = 0; i < 6; i++) {
    const d = decide("", state, now, () => quietWork);
    assert.equal(d.run, false);
    waits.push(d.state.backoffMs / MIN);
    state = d.state;
    now = state.nextCheckAt;
  }
  assert.deepEqual(waits, [60, 120, 240, 240, 240, 240]);
  assert.equal(MAX_BACKOFF_MS / MIN, 240);
});

test("new work runs the tick and resets the backoff", () => {
  const state = { status: "quiet", recordedAt: T0, fingerprint: quietWork.hash, parts: quietWork.parts, backoffMs: 4 * BASE_BACKOFF_MS, nextCheckAt: T0 + MIN_INTERVAL_MS };
  const changed = hashParts({ prs: [{ n: 1, head: "b" }, { n: 2, head: "c" }], main: { headSha: "m1" }, inbox: ["2026-10-08-x.md"] });
  const d = decide("", state, T0 + 3 * 60 * MIN, () => changed);
  assert.equal(d.run, true);
  assert.match(d.why, /#1 changed, #2 opened, inbox changed/);
  assert.equal(d.state.backoffMs, BASE_BACKOFF_MS);
  assert.equal(d.state.status, "running");
});

test("a skipped Skill call is denied with a wakeup suggestion", () => {
  const state = { status: "done", recordedAt: T0, nextCheckAt: T0 + 40 * MIN };
  const d = decide("", state, T0 + 15 * MIN, noFingerprint);
  const out = hookOutput({ hook_event_name: "PreToolUse" }, d, T0 + 15 * MIN);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /ScheduleWakeup .*delaySeconds 1500, noop true/);
});

test("only /fleet-manager invocations are handled", () => {
  assert.equal(parseInvocation({ hook_event_name: "UserPromptSubmit", prompt: "/fleet-manager once" }), "once");
  assert.equal(parseInvocation({ hook_event_name: "UserPromptSubmit", prompt: "/power-tools:fleet-manager" }), "");
  assert.equal(parseInvocation({ hook_event_name: "UserPromptSubmit", prompt: "/fleet-status" }), null);
  assert.equal(parseInvocation({ hook_event_name: "UserPromptSubmit", prompt: "please /fleet-manager" }), null);
  assert.equal(parseInvocation({ hook_event_name: "PreToolUse", tool_input: { skill: "fleet-manager", args: "ci" } }), "ci");
  assert.equal(parseInvocation({ hook_event_name: "PreToolUse", tool_input: { skill: "power-tools:fleet-manager" } }), "");
  assert.equal(parseInvocation({ hook_event_name: "PreToolUse", tool_input: { skill: "pr-dashboard" } }), null);
});

test("state is kept per repo, and the hook ignores unrelated prompts", () => {
  assert.notEqual(stateFile("acme/widgets"), stateFile("acme/gadgets"));
  assert.match(stateFile("acme/widgets").replaceAll("\\", "/"), /fleet-manager\/acme-widgets\/debounce\.json$/);
  assert.equal(describeChange(null, quietWork.parts), "no earlier snapshot");
  const out = execFileSync(process.execPath, [SCRIPT], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "hello" }), encoding: "utf8" });
  assert.equal(out, "");
});
