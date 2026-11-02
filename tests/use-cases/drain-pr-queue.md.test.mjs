// Use case: tests/use-cases/drain-pr-queue.md
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { skillFile } from "../../scripts/layout.mjs";

const SKILL = readFileSync(skillFile("drain-pr-queue", "SKILL.md"), "utf8");

test("drain-pr-queue is explicit-invocation only", () => {
  assert.match(SKILL, /^name: drain-pr-queue$/m);
  assert.match(SKILL, /^disable-model-invocation: true$/m);
  assert.match(SKILL, /^description:.*'\/drain-pr-queue'.*'merge all open PRs'/m);
  assert.match(SKILL, /Run it only because the user explicitly asked for it/);
});

test("it takes drafts and merge method as flags", () => {
  assert.match(SKILL, /^argument-hint:.*--include-drafts.*--method squash\|merge\|rebase/m);
  assert.match(SKILL, /Without it, drafts are skipped/);
  assert.match(SKILL, /else squash/);
});

test("every merge is guarded by the head SHA", () => {
  assert.match(SKILL, /gh pr merge <n> --<method> --match-head-commit <sha>/);
  assert.match(SKILL, /Re-read the PR right before merging/);
  assert.match(SKILL, /merge it with the new head SHA as the guard/);
});

test("green means more than 0 checks and no failures", () => {
  assert.match(SKILL, /total checks > 0 and no failing required checks/);
  assert.match(SKILL, /"0 checks \+ mergeable" is not green/);
});

test("conflicts are fixed in a worktree by merging the base, never rebasing", () => {
  assert.match(SKILL, /git worktree add \.\.\/<repo>-pr-<n> <head-branch>/);
  assert.match(SKILL, /Never rebase a shared branch/);
  assert.match(SKILL, /Resolve conflicts in a dedicated worktree, never in a dirty main checkout/);
});

test("the never-list and ownership rule are stated", () => {
  assert.match(SKILL, /\*\*Never\*\* force-push, use `--no-verify`, bypass branch protection \(`--admin`\), or deploy/);
  assert.match(SKILL, /\*\*Respect ownership\.\*\*/);
  assert.match(SKILL, /confirmation that no mergeable PR remains in scope/);
});
