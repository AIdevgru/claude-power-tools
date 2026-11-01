// Use case: tests/use-cases/git-guard.md
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skillFile, skillModule } from "../../scripts/layout.mjs";
const { approvals, approve, authored, checksVerdict, evaluate, parseApprovals, record, segments } = await skillModule("git-guard", "scripts/git-guard.mjs");

const SCRIPT = skillFile("git-guard", "scripts", "git-guard.mjs");
const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));

function repo() {
  const dir = tmp("cpt-guard-");
  const git = (...a) => execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "hello\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { dir, git };
}

// Run the whole file from an empty folder outside any repo, so no verdict depends on the checkout
// running the tests: a main checkout with worktrees trips commit-on-main, and its
// .claude/git-guard.json can switch rules off. Every evaluate() and hook run without a cwd lands here.
process.chdir(tmp("cpt-guard-cwd-"));

const rule = (cmd, opts) => evaluate(cmd, { home: tmp("cpt-guard-home-"), ...opts })?.rule ?? "allow";

test("the shell splitter keeps quoted text together and splits at operators", () => {
  assert.deepEqual(segments('git commit -m "a; b && c" && git push'), [["git", "commit", "-m", "a; b && c"], ["git", "push"]]);
  assert.deepEqual(segments("cd x; git status | head"), [["cd", "x"], ["git", "status"], ["head"]]);
});

test("--no-verify, commit -n and core.hooksPath are denied", () => {
  assert.equal(rule("git commit --no-verify -m x"), "no-verify");
  assert.equal(rule("git commit -nm x"), "no-verify");
  assert.equal(rule("git -c core.hooksPath=/dev/null commit -m x"), "no-verify");
  assert.equal(rule("git push --no-verify origin feat/x"), "no-verify");
  assert.equal(rule('git commit -am "skip -n mention"'), "allow");
});

test("force-push is denied; a lease is fine except on main", () => {
  assert.equal(rule("git push --force origin feat/x"), "force-push");
  assert.equal(rule("git push -fu origin feat/x"), "force-push");
  assert.equal(rule("git push origin +feat/x"), "force-push");
  assert.equal(rule("git push --force-with-lease origin feat/x"), "allow");
  assert.equal(rule("git push --force-with-lease origin main"), "force-push");
  assert.equal(rule("git push origin --delete main"), "force-push");
  assert.equal(rule("git push -u origin feat/x"), "allow");
});

test("committing on main is denied only while other worktrees share it", () => {
  const { dir, git } = repo();
  assert.equal(rule("git commit -m x", { cwd: dir }), "allow");
  git("worktree", "add", "-q", "-b", "feat/a", path.join(dir, "..", `${path.basename(dir)}-a`));
  const v = evaluate("git commit -m x", { cwd: dir, home: tmp("cpt-guard-home-") });
  assert.equal(v.rule, "commit-on-main");
  assert.match(v.reason, /git worktree add/);
});

test("branch changes in a dirty main checkout are denied unless this session wrote the files", () => {
  const { dir, git } = repo();
  const wt = path.join(dir, "..", `${path.basename(dir)}-wt`);
  git("worktree", "add", "-q", "-b", "feat/wt", wt);
  writeFileSync(path.join(dir, "README.md"), "edited by session A\n");
  const home = tmp("cpt-guard-home-");

  const b = evaluate("git checkout -b fix/footer", { cwd: dir, session: "B", home });
  assert.equal(b.rule, "dirty-main-checkout");
  assert.match(b.reason, /README\.md/);
  for (const cmd of ["git stash", "git switch main", "git pull", "git reset --hard", "git clean -fd"]) {
    assert.equal(evaluate(cmd, { cwd: dir, session: "B", home })?.rule, "dirty-main-checkout", cmd);
  }
  assert.equal(evaluate("git stash list", { cwd: dir, session: "B", home }), null);

  // The ledger keeps real paths: tmpdir() may be an 8.3 short path while git reports long ones.
  record(home, "A", path.join(dir, "README.md"));
  assert.ok(authored(home, "A").has(realpathSync.native(path.join(dir, "README.md")).toLowerCase()));
  assert.equal(evaluate("git checkout -b fix/footer", { cwd: dir, session: "A", home }), null);

  // From a linked worktree, or after cd into one, it's that session's own checkout.
  assert.equal(evaluate("git checkout -b fix/other", { cwd: wt, session: "B", home }), null);
  assert.equal(evaluate(`cd "${wt}" && git checkout -b fix/other`, { cwd: dir, session: "B", home }), null);
  assert.equal(evaluate(`git -C "${dir}" checkout -b fix/other`, { cwd: wt, session: "B", home })?.rule, "dirty-main-checkout");
});

test("deleting a folder that holds a junction is denied until the link is gone", () => {
  const outside = tmp("cpt-guard-target-");
  writeFileSync(path.join(outside, "keep.txt"), "precious\n");
  const wt = tmp("cpt-guard-wt-");
  symlinkSync(outside, path.join(wt, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const plain = tmp("cpt-guard-plain-");
  mkdirSync(path.join(plain, "sub"));

  const v = evaluate(`rm -rf "${wt}"`, { home: tmp("cpt-guard-home-") });
  assert.equal(v.rule, "junction-delete");
  assert.match(v.reason, /node_modules/);
  assert.equal(rule(`Remove-Item -Recurse -Force "${wt}"`), "junction-delete");
  assert.equal(rule(`Remove-Item -LiteralPath "${wt}" -Recurse`), "junction-delete");
  assert.equal(rule(`git worktree remove "${wt}"`), "junction-delete");
  assert.equal(rule(`rm -rf "${plain}"`), "allow");
  assert.equal(rule(`rm "${path.join(wt, "file")}"`), "allow");
});

test("a repo can switch a rule off in .claude/git-guard.json", () => {
  const { dir, git } = repo();
  git("worktree", "add", "-q", "-b", "feat/b", path.join(dir, "..", `${path.basename(dir)}-b`));
  mkdirSync(path.join(dir, ".claude"));
  writeFileSync(path.join(dir, ".claude", "git-guard.json"), JSON.stringify({ allow: ["commit-on-main"] }));
  // The config file itself is dirty, but committing isn't a checkout-type command.
  assert.equal(rule("git commit -m x", { cwd: dir }), "allow");
  assert.equal(rule("git commit --no-verify -m x", { cwd: dir }), "no-verify");
});

test("hook mode denies with JSON, records edits, and fails open", () => {
  const home = tmp("cpt-guard-home-");
  const run = (input) => spawnSync(process.execPath, [SCRIPT], { input, encoding: "utf8", env: { ...process.env, GIT_GUARD_HOME: home } });

  const deny = run(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push --force" }, cwd: tmpdir(), session_id: "s1" }));
  assert.equal(deny.status, 0);
  const out = JSON.parse(deny.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /^git-guard \(force-push\)/);

  const allow = run(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "PowerShell", tool_input: { command: "git status" }, cwd: tmpdir() }));
  assert.equal(allow.stdout, "");

  const edited = path.join(tmpdir(), "edited.txt");
  const file = path.join(realpathSync.native(tmpdir()), "edited.txt");
  run(JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: edited }, cwd: tmpdir(), session_id: "s1" }));
  assert.ok(authored(home, "s1").has(file.toLowerCase()));

  const broken = run("{ not json");
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, "");

  // Windows PowerShell 5.1 prefixes piped text with a byte-order mark; the rules still apply.
  const bom = run(`﻿${JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push --force" }, cwd: tmpdir() })}`);
  assert.equal(JSON.parse(bom.stdout).hookSpecificOutput.permissionDecision, "deny");

  // The owner's prompt records merge approvals for the session.
  // Outside a repo there's no repo or head to bind it to, so the gate won't honor it.
  run(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "approve merge #12\nlooks good", session_id: "s1", cwd: tmpdir() }));
  assert.deepEqual(approvals(home, "s1"), [{ pr: 12, anyway: false, repo: null, head: null }]);
  assert.ok(authored(home, "s1").has(file.toLowerCase()), "approvals keep the edit ledger");

  const self = spawnSync(process.execPath, [SCRIPT, "--self-test"], { encoding: "utf8" });
  assert.equal(self.status, 0);
  assert.match(self.stdout, /^ok git-guard/);
});

test("merge approvals come only from a first line that is only the approval", () => {
  assert.deepEqual(parseApprovals("approve merging #3 and #4\nthanks"), [{ pr: 3, anyway: false }, { pr: 4, anyway: false }]);
  assert.deepEqual(parseApprovals("  Approve merge 9 anyway."), [{ pr: 9, anyway: true }]);
  assert.deepEqual(parseApprovals("approve merge #3, #4 & 5"), [3, 4, 5].map((pr) => ({ pr, anyway: false })));
  for (const no of ["don't approve merge #12 yet", "should I approve merge #12?", "approve merge #12?", "approve merge #12 after the e2e fix",
    "merge #12", "status please\napprove merge #12", "> approve merge #12"]) {
    assert.deepEqual(parseApprovals(no), [], no);
  }
});

test("a repo's own file can't switch off a merge gate enabled globally", () => {
  const { dir } = repo();
  const home = tmp("cpt-guard-home-");
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ enable: ["merge-gate"] }));
  mkdirSync(path.join(dir, ".claude"));
  writeFileSync(path.join(dir, ".claude", "git-guard.json"), JSON.stringify({ allow: ["merge-gate"] }));
  assert.equal(evaluate("gh pr merge 12", { home, session: "s", cwd: dir })?.rule, "merge-gate");
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ enable: ["merge-gate"], allow: ["merge-gate"] }));
  assert.equal(evaluate("gh pr merge 12", { home, session: "s", cwd: dir }), null);
});

test("check verdicts: zero checks, red and running are not green", () => {
  const ok = { name: "test", status: "COMPLETED", conclusion: "SUCCESS" };
  assert.equal(checksVerdict([ok, { name: "lint", status: "COMPLETED", conclusion: "SKIPPED" }]), null);
  assert.match(checksVerdict([]), /no checks/);
  assert.match(checksVerdict([{ name: "lint", status: "COMPLETED", conclusion: "SKIPPED" }]), /no checks/);
  assert.match(checksVerdict([ok, { name: "e2e", status: "COMPLETED", conclusion: "FAILURE" }]), /1 check\(s\) failed: e2e/);
  assert.match(checksVerdict([ok, { name: "e2e", status: "COMPLETED", conclusion: "STALE" }]), /1 check\(s\) failed: e2e/);
  assert.match(checksVerdict([ok, { name: "e2e", status: "IN_PROGRESS", conclusion: "" }]), /still running: e2e/);
  assert.match(checksVerdict([{ context: "ci/legacy", state: "PENDING" }]), /still running/);
  assert.equal(checksVerdict([{ context: "ci/legacy", state: "SUCCESS" }]), null);
});

test("the merge gate is opt-in, then needs the owner's approval and green checks", () => {
  const home = tmp("cpt-guard-home-");
  const green = [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }];
  const red = [{ name: "trivy", status: "COMPLETED", conclusion: "FAILURE" }];
  const { dir, git } = repo();
  git("remote", "add", "origin", "https://github.com/Acme/App.git");
  let head = "aaa111";
  const seen = [];
  const view = (rollup) => (pr, r, cwd) => (seen.push([pr, r, cwd]), { head, rollup });
  const gate = (cmd, rollup = green, cwd = dir) => evaluate(cmd, { home, session: "s", cwd, ghView: view(rollup) });
  const ok = (prompt) => approve(home, "s", prompt, { cwd: dir, view: view(green) });

  // Off by default.
  assert.equal(gate("gh pr merge 12 --squash"), null);
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ enable: ["merge-gate"] }));

  const v = gate("gh pr merge 12 --squash");
  assert.equal(v.rule, "merge-gate");
  assert.match(v.reason, /approve merge #12/);

  // The approval is tied to this repo and #12's head commit at the time.
  assert.deepEqual(ok("approve merge #12"), [{ pr: 12, anyway: false, repo: "acme/app", head: "aaa111" }]);
  assert.equal(gate("gh pr merge 12 --squash"), null);
  assert.equal(gate("gh pr merge https://github.com/acme/app/pull/12 --merge"), null);
  assert.equal(gate("gh pr merge -R acme/app 12"), null);
  assert.deepEqual(seen.at(-1).slice(0, 2), [12, "acme/app"]);
  assert.match(gate("gh pr merge 12", red).reason, /isn't ready: 1 check\(s\) failed: trivy/);
  assert.match(gate("gh pr merge 12", []).reason, /no checks ran/);
  const unreadable = evaluate("gh pr merge 12", { home, session: "s", cwd: dir, ghView: () => { throw new Error("HTTP 502"); } });
  assert.match(unreadable.reason, /couldn't be read \(HTTP 502\)/);

  // #12 in another repo isn't approved, and nor is #12 once it has new commits.
  assert.match(gate("gh pr merge -R evil/fork 12").reason, /approved merging evil\/fork#12/);
  assert.match(gate("gh pr merge https://github.com/evil/fork/pull/12").reason, /evil\/fork#12/);
  head = "bbb222";
  assert.match(gate("gh pr merge 12").reason, /new commits since the owner approved/);
  ok("approve merge #12");
  assert.equal(gate("gh pr merge 12"), null);

  // An approval gh couldn't tie to a head isn't honored; outside a repo there's nothing to match.
  approve(home, "s", "approve merge #13", { cwd: dir, view: () => { throw new Error("offline"); } });
  assert.match(gate("gh pr merge 13").reason, /couldn't be tied to its head commit/);
  assert.match(gate("gh pr merge 12", green, tmpdir()).reason, /Can't tell which repo/);

  // Approving #12 doesn't approve #14; "anyway" skips the checks for that PR only, not the head check.
  assert.match(gate("gh pr merge 14", green).reason, /approve merge #14/);
  ok("approve merge #14 anyway");
  assert.equal(gate("gh pr merge 14", red), null);
  assert.match(gate("gh pr merge 12", red).reason, /isn't ready/);
  head = "ccc333";
  assert.match(gate("gh pr merge 14", red).reason, /new commits/);
  head = "bbb222";

  // --admin and branch names are refused whatever was approved; other sessions have no approvals.
  assert.match(gate("gh pr merge 12 --admin").reason, /--admin/);
  assert.match(gate("gh pr merge feat/x").reason, /by number/);
  assert.equal(evaluate("gh pr merge 12", { home, session: "other", cwd: dir, ghView: view(green) }).rule, "merge-gate");
  assert.equal(gate("gh pr view 12"), null);
  assert.equal(gate("git status; gh pr merge 99").rule, "merge-gate");

  // A Git Bash cwd (/c/Users/...) reaches gh as a native path.
  if (process.platform === "win32") {
    const posix = `/${dir[0].toLowerCase()}${dir.slice(2).replace(/\\/g, "/")}`;
    assert.equal(gate("gh pr merge 12", green, posix), null);
    assert.equal(path.resolve(seen.at(-1)[2]).toLowerCase(), path.resolve(dir).toLowerCase());
  }
});
