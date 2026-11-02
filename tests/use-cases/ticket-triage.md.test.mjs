// Use case: tests/use-cases/ticket-triage.md
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { skillFile } from "../../scripts/layout.mjs";

const SKILL = readFileSync(skillFile("ticket-triage", "SKILL.md"), "utf8");

test("ticket-triage triggers on its command and phrases", () => {
  assert.match(SKILL, /^name: ticket-triage$/m);
  assert.match(SKILL, /^description:.*'\/ticket-triage'.*'check Jira'.*'triage the tickets'/m);
  assert.match(SKILL, /^argument-hint:.*ticket keys to triage/m);
});

test("it reads tracker settings and never triages another project by mistake", () => {
  assert.match(SKILL, /`## Power tools` section/);
  assert.match(SKILL, /`triaged-label` \(default `triaged`\)/);
  assert.match(SKILL, /Never triage another project by mistake/);
});

test("it finds untriaged To Do tickets oldest first, and stops quietly when there are none", () => {
  assert.match(SKILL, /status = "To Do"/);
  assert.match(SKILL, /ORDER BY created ASC/);
  assert.match(SKILL, /sort:created-asc/);
  assert.match(SKILL, /"No new tickets\."/);
});

test("each analysis has a summary, analysis and one of four recommendations", () => {
  for (const part of ["**Summary:**", "**Analysis:**", "**Recommendation:**"]) assert.ok(SKILL.includes(part), part);
  for (const rec of ["`take`", "`take after <key>`", "`needs clarification: <question>`", "`decline: <reason>`"]) assert.ok(SKILL.includes(rec), rec);
  assert.match(SKILL, /size S\/M\/L/);
});

test("it posts the analysis, labels the ticket and keeps existing labels", () => {
  assert.match(SKILL, /post the analysis as a comment/);
  assert.match(SKILL, /add the triaged label while keeping the existing labels/);
});

test("it asks act-or-skip with a multi-select and hands picks to ticket-to-pr", () => {
  assert.match(SKILL, /`multiSelect: true`/);
  assert.match(SKILL, /`act <key>`/);
  assert.match(SKILL, /at most 4 options/);
  assert.match(SKILL, /run the `ticket-to-pr` skill on it/);
  assert.match(SKILL, /parallel background agents/);
});

test("triage never edits code and never moves a ticket out of To Do", () => {
  assert.match(SKILL, /Triage never edits code and never moves a ticket out of To Do\./);
});
