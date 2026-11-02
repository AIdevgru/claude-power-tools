// Use case: tests/use-cases/combine-prs.md
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { skillFile } from "../../scripts/layout.mjs";

const SKILL = readFileSync(skillFile("combine-prs", "SKILL.md"), "utf8");

test("combine-prs triggers on its slash command and plain phrases", () => {
  assert.match(SKILL, /^name: combine-prs$/m);
  assert.match(SKILL, /^description:.*'\/combine-prs'.*'combine these PRs into one'.*'one big PR'/m);
  assert.match(SKILL, /^argument-hint:.*PR numbers/m);
  assert.match(SKILL, /If `\$ARGUMENTS` is empty, run `gh pr list --state open`/);
  assert.match(SKILL, /whether the originals should be closed/);
});

test("it never touches the source branches, merges, or force-pushes", () => {
  assert.match(SKILL, /\*\*Never touch the original PR branches\.\*\*/);
  assert.match(SKILL, /\*\*Never\*\* merge the combined PR, deploy, use `--no-verify` or force-push/);
  assert.match(SKILL, /Never `git checkout` or `git stash` in the main checkout/);
  assert.match(SKILL, /This skill never merges or deploys/);
});

test("it trial-merges in a worktree, then resolves conflicts in a pairwise tree", () => {
  assert.match(SKILL, /branch `feat\/combined-<short-name>`/);
  assert.match(SKILL, /git merge --abort/);
  assert.match(SKILL, /git worktree add -b merge\/combined-<n>/);
  assert.match(SKILL, /merge\/combined-<n>-<m>/);
  assert.match(SKILL, /Validate once, fully/);
});

test("originals are closed only when the owner chose it", () => {
  assert.match(SKILL, /Only if the user chose it in phase 1, close each original PR/);
  assert.match(SKILL, /leave their branches in place/);
});
