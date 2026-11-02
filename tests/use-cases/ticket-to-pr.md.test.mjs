// Use case: tests/use-cases/ticket-to-pr.md
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { skillFile } from "../../scripts/layout.mjs";

const SKILL = readFileSync(skillFile("ticket-to-pr", "SKILL.md"), "utf8");

test("ticket-to-pr triggers on its command and takes a ticket key", () => {
  assert.match(SKILL, /^name: ticket-to-pr$/m);
  assert.match(SKILL, /^description:.*'\/ticket-to-pr <key>'.*'act on <key>'.*\/ticket-triage/m);
  assert.match(SKILL, /^argument-hint:.*ABC-12.*#42.*--no-ui.*--score N/m);
  assert.match(SKILL, /If it's empty, ask once/);
});

test("it reads tracker settings for Jira and GitHub Issues", () => {
  assert.match(SKILL, /`## Power tools` section/);
  for (const key of ["jira-cloud-id", "jira-project", "jira-transitions", "worktree-root:", "merge-method:"]) assert.ok(SKILL.includes(key), key);
  assert.match(SKILL, /labels `in-progress` and `in-review`/);
});

test("the build goes to a background agent that makes its own worktree off origin/main", () => {
  assert.match(SKILL, /background `general-purpose` Agent \(no `isolation`/);
  assert.match(SKILL, /branch named `<type>\/<key>-<slug>`/);
  assert.match(SKILL, /Run `\/code-review high` on the PR, fix every confirmed finding/);
  assert.match(SKILL, /total checks > 0 and all green/);
});

test("this session runs the UI gate, posts the take and moves the ticket to In Review", () => {
  assert.match(SKILL, /which is why this session runs it rather than the build agent/);
  assert.match(SKILL, /\*\*Post the take\*\* as a PR comment/);
  assert.match(SKILL, /then move the ticket to In Review|move the ticket to In Review/);
});

test("it asks merge or hold and never merges without an explicit merge", () => {
  assert.match(SKILL, /\*\*merge\*\* or \*\*hold\*\*/);
  assert.match(SKILL, /re-check that CI is green on the current head/);
  assert.match(SKILL, /leave the ticket In Review and the worktree in place/);
  assert.match(SKILL, /Never merge without the explicit "merge" choice\./);
});

test("the shared delivery rules it links to exist", () => {
  assert.match(SKILL, /\]\(reference\/delivery-rules\.md\)/);
  assert.ok(existsSync(skillFile("ticket-to-pr", "reference", "delivery-rules.md")));
});
