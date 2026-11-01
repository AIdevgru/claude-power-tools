// Use case: tests/use-cases/pr-dashboard.md
// The dashboard's own suite (67 stdlib unittest cases over sanitized fixtures) lives next to the
// script; this runs it so `npm test` covers it too.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { skillDir } from "../../scripts/layout.mjs";

const SKILL = skillDir("pr-dashboard");

function python() {
  for (const exe of ["python3", "python"]) {
    const r = spawnSync(exe, ["-I", "-c", "import sys; print(sys.version_info >= (3, 10))"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "True") return exe;
  }
  return null;
}

const exe = python();

test("the pr-dashboard unittest suite passes", { skip: exe ? false : "Python 3.10+ not found" }, () => {
  // -I ignores PYTHON* variables, so -B (not PYTHONDONTWRITEBYTECODE) keeps __pycache__ out.
  const r = spawnSync(exe, ["-I", "-B", "-m", "unittest", "discover", "-s", "tests"], {
    cwd: SKILL, encoding: "utf8", timeout: 300_000,
  });
  const tail = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-25).join("\n");
  assert.equal(r.status, 0, tail);
  assert.match(r.stderr, /Ran \d+ tests/);
  assert.match(r.stderr, /\nOK/);
});
