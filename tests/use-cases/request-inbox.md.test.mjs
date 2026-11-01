// Use case: tests/use-cases/request-inbox.md
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skillFile, skillModule } from "../../scripts/layout.mjs";
const { init, requestMeta, resolveInbox, snapshot } = await skillModule("request-inbox", "scripts/inbox.mjs");

const SCRIPT = skillFile("request-inbox", "scripts", "inbox.mjs");

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "cpt-inbox-"));
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

function run(cwd, args = [], env = {}) {
  const clean = { ...process.env, ...env };
  delete clean.CLAUDE_PROJECT_DIR;
  if (!("CLAUDE_INBOX_DIR" in env)) delete clean.CLAUDE_INBOX_DIR;
  return execFileSync(process.execPath, [SCRIPT, ...args], { cwd, env: clean, encoding: "utf8" });
}

test("init creates the inbox with its tracked docs, once", () => {
  const dir = repo();
  const root = path.join(dir, ".claude-inbox");
  assert.deepEqual(init(root).sort(), [".gitignore", "README.md", "TEMPLATE.md"]);
  assert.deepEqual(init(root), []);
  assert.match(readFileSync(path.join(root, ".gitignore"), "utf8"), /^\*$/m);
  assert.match(run(dir, ["init"]), /already set up/);
});

test("requests list urgent first, then oldest; claims and owner waits are shown", () => {
  const dir = repo();
  const root = path.join(dir, ".claude-inbox");
  init(root);
  writeFileSync(path.join(root, "2026-10-08-fix-footer.md"), "# Fix the footer\n\n**Priority:** normal\n");
  writeFileSync(path.join(root, "2026-10-09-rotate-keys.md"), "# Rotate keys\n\n**Priority:** urgent\n");
  let out = run(dir);
  assert.ok(out.indexOf("2026-10-09-rotate-keys.md (priority: urgent") < out.indexOf("2026-10-08-fix-footer.md (priority: normal"), out);
  assert.doesNotMatch(out, /README|TEMPLATE/);

  mkdirSync(path.join(root, "in-progress"));
  renameSync(path.join(root, "2026-10-09-rotate-keys.md"), path.join(root, "in-progress", "2026-10-09-rotate-keys.md"));
  writeFileSync(path.join(root, "in-progress", "2026-10-09-rotate-keys.md"), "# Rotate keys\n\n> Claimed by repo-a1 at 2026-10-09T12:00:00Z\n", { flag: "a" });
  out = run(dir);
  assert.match(out, /in-progress\/2026-10-09-rotate-keys\.md \(claimed by repo-a1\)/);

  mkdirSync(path.join(root, "needs-owner"));
  renameSync(path.join(root, "in-progress", "2026-10-09-rotate-keys.md"), path.join(root, "needs-owner", "2026-10-09-rotate-keys.md"));
  out = run(dir);
  assert.match(out, /waiting on the owner, do not act: needs-owner\/2026-10-09-rotate-keys\.md/);
  assert.doesNotMatch(out, /in-progress\//);
});

test("a worktree sees the main checkout's inbox", () => {
  const dir = repo();
  execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
  execFileSync("git", ["-C", dir, "worktree", "add", "-q", wt]);
  init(path.join(dir, ".claude-inbox"));
  writeFileSync(path.join(dir, ".claude-inbox", "2026-10-10-a.md"), "# A\n");
  assert.match(run(wt), /2026-10-10-a\.md/);
  // Compare real paths: git reports long names where tmpdir() may be an 8.3 short path (Windows CI).
  assert.equal(realpathSync.native(resolveInbox(wt, {}).root), realpathSync.native(path.join(dir, ".claude-inbox")));
});

test("the session-start hook is silent in a repo without an inbox", () => {
  const dir = repo();
  assert.equal(run(dir, ["--hook"]), "");
  assert.match(run(dir), /not set up/);
  assert.equal(existsSync(path.join(dir, ".claude-inbox")), false);
});

test("the legacy .ForClaude name and nested inbox/ layout keep working", () => {
  const dir = repo();
  const root = path.join(dir, ".ForClaude");
  mkdirSync(path.join(root, "inbox"), { recursive: true });
  writeFileSync(path.join(root, "inbox", "2026-10-11-old.md"), "---\npriority: urgent\n---\n# Old style\n");
  const out = run(dir, ["--hook"]);
  assert.match(out, /\.ForClaude/);
  assert.match(out, /inbox\/2026-10-11-old\.md \(priority: urgent\)/);
});

test("CLAUDE_INBOX_DIR overrides the location", () => {
  const dir = repo();
  const elsewhere = mkdtempSync(path.join(tmpdir(), "cpt-inbox-env-"));
  writeFileSync(path.join(elsewhere, "2026-10-12-x.md"), "# X\n");
  assert.match(run(dir, [], { CLAUDE_INBOX_DIR: elsewhere }), /2026-10-12-x\.md/);
});

test("request metadata reads front matter and Markdown forms", () => {
  assert.deepEqual(requestMeta("---\npriority: urgent\nclaimed-by: s1\n---\n"), { priority: "urgent", deliverable: "", claimedBy: "s1" });
  assert.equal(requestMeta("# T\n**Priority:** Urgent\n").priority, "urgent");
  assert.equal(requestMeta("> Claimed by a at t\n> Claimed by b at t2 (re-claim of a)\n").claimedBy, "b");
  assert.deepEqual(snapshot(mkdtempSync(path.join(tmpdir(), "cpt-empty-"))).pending, []);
});
