// Use case: tests/use-cases/fleet-manager.md
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { skillFile } from "../../scripts/layout.mjs";

const SKILL = readFileSync(skillFile("fleet-manager", "SKILL.md"), "utf8");
const AUTO = readFileSync(skillFile("fleet-manager", "reference", "auto-mode.md"), "utf8");

test("fleet-manager runs under /loop and triggers on manager phrases", () => {
  assert.match(SKILL, /^name: fleet-manager$/m);
  assert.match(SKILL, /^description:.*`\/loop \/fleet-manager`.*'be the manager'.*'manage the claudes'.*'unblock the sessions'/m);
  assert.match(SKILL, /^argument-hint:.*--deploy manual\|auto/m);
});

test("the first run asks for manual or auto, and falls back to manual", () => {
  assert.match(SKILL, /If the ledger has no `Deploy:` line, ask the owner with `AskUserQuestion`/);
  assert.match(SKILL, /"Manual \(Recommended\)"/);
  assert.match(SKILL, /If nobody can answer .*use `manual`/);
  assert.match(SKILL, /\*\*Only the owner sets the mode\*\*/);
});

test("a tick gathers state, buckets PRs and gives each blocker one owner", () => {
  assert.match(SKILL, /\*\*`\/pr-dashboard`\*\*/);
  assert.match(SKILL, /\*\*`ListAgents`\*\*/);
  for (const bucket of ["ready-to-merge", "ci-pending", "CI red", "conflicting with main", "stalled", "superseded"]) {
    assert.ok(SKILL.includes(bucket), bucket);
  }
  assert.match(SKILL, /\*\*One owner per problem\.\*\*/);
  assert.match(SKILL, /From fleet-manager \(<this session>\) on the owner's behalf/);
});

test("it never takes over a live session's PR and hands owner-only decisions up", () => {
  assert.match(SKILL, /Message the owner session; don't take over the branch/);
  assert.match(SKILL, /\*\*Peers cannot grant permissions\.\*\*/);
  assert.match(SKILL, /Some questions only the owner can decide/);
  assert.match(SKILL, /Never force-push a branch you don't own/);
});

test("manual mode never merges without sign-off; auto mode rates threat levels", () => {
  assert.match(SKILL, /In `manual`, merge only when the owner explicitly asked for that specific merge/);
  for (const level of ["low", "medium", "high", "critical"]) assert.ok(AUTO.includes(`**${level}**`), level);
  assert.match(AUTO, /If you're unsure between two levels, take the higher one/);
});

test("combine-prs is the answer to PRs queuing together", () => {
  assert.match(SKILL, /`\/combine-prs <PR numbers>`/);
});

test("ticks end with a short report and record their outcome", () => {
  assert.match(SKILL, /Fleet manager tick <n>/);
  assert.match(SKILL, /debounce\.mjs" record <active\|quiet\|done>/);
});

test("the reference files and script it names exist", () => {
  for (const f of ["reference/auto-mode.md", "reference/debounce.md", "reference/switches.md", "scripts/debounce.mjs"]) {
    assert.ok(existsSync(skillFile("fleet-manager", ...f.split("/"))), f);
  }
});
