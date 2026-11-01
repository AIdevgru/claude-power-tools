// Use case: tests/use-cases/fleet-status.md
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skillFile } from "../../scripts/layout.mjs";

const SKILL = readFileSync(skillFile("fleet-status", "SKILL.md"), "utf8");
const SCRIPT = skillFile("pr-dashboard", "scripts", "pr_dashboard.py");

function python() {
  for (const exe of ["python3", "python"]) {
    const r = spawnSync(exe, ["-I", "-c", "import sys; print(sys.version_info >= (3, 10))"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "True") return exe;
  }
  return null;
}
const exe = python();

test("fleet-status reads status lines through pr-dashboard's status-dir, not its own listing", () => {
  assert.match(SKILL, /pr-dashboard\/scripts\/pr_dashboard\.py/);
  assert.match(SKILL, /status-dir --recent 15/);
  assert.doesNotMatch(SKILL, /stat -c %Y/, "no hand-rolled shell listing of the status folder");
  assert.match(SKILL, /^allowed-tools:.*\bRead\b/m);
});

test("only stale peers are messaged, and they are told to Read before overwriting their file", () => {
  assert.match(SKILL, /\*\*CURRENT\*\*: the peer is in RECENT\. Send it \*\*no message\*\*/);
  assert.match(SKILL, /never to a CURRENT one/);
  assert.match(SKILL, /if the file already exists, Read it first/);
  for (const field of ["Description:", "ASK:", "BLOCKER:", "State"]) assert.ok(SKILL.includes(`**${field}`), field);
});

test("status-dir --recent lists only fresh, non-empty, non-scratch lines", { skip: exe ? false : "Python 3.10+ not found" }, () => {
  const home = mkdtempSync(path.join(tmpdir(), "cpt-fleet-status-"));
  const dir = path.join(home, "status");
  mkdirSync(dir);
  const line = (name) => `${name} | #12 | fixing the footer | waiting on - | next push ~5m | ask owner - | 20m\n`;
  writeFileSync(path.join(dir, "repo-a.txt"), line("repo-a"));
  writeFileSync(path.join(dir, "repo-b.txt"), line("repo-b"));
  const old = Date.now() / 1000 - 30 * 60;
  utimesSync(path.join(dir, "repo-b.txt"), old, old);
  writeFileSync(path.join(dir, "repo-c.txt"), "");
  writeFileSync(path.join(dir, "_scratch.txt"), line("_scratch"));

  const r = spawnSync(exe, ["-I", "-B", SCRIPT, "status-dir", "--recent", "15"], {
    encoding: "utf8", env: { ...process.env, PR_DASHBOARD_HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);
  const [statusDir, now, recent] = r.stdout.trim().split(/\r?\n/);
  assert.equal(path.resolve(statusDir), path.resolve(dir), "prints the folder as a native path");
  assert.match(now, /^\d{10}$/);
  assert.equal(recent, "repo-a");
});
