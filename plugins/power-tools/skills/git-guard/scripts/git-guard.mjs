#!/usr/bin/env node
// git-guard: a PreToolUse hook that blocks the git and delete commands that have cost parallel
// Claude sessions their work, and a PostToolUse hook that remembers which files this session
// wrote, so "dirty files you didn't author" can be told apart from your own.
//
//   node git-guard.mjs                                 hook mode (reads the hook JSON on stdin)
//   node git-guard.mjs check [--cwd DIR] [--session ID] -- <command>
//                                                      prints "allow" or "deny: <reason>"
//   node git-guard.mjs status                          where the ledger and config live
//   node git-guard.mjs --self-test                     prints "ok git-guard" when the hook would work
//
// Rules (each can be switched off per repo in <main checkout>/.claude/git-guard.json or for every
// repo in <GIT_GUARD_HOME>/config.json, as {"allow": ["<rule>", ...]}; opt-in rules are switched
// on the same way with {"enable": ["<rule>", ...]}):
//   no-verify            --no-verify, commit -n, or -c core.hooksPath=... on commit/push/merge/rebase
//   force-push           push --force/-f/+refspec (--force-with-lease is fine, except to main/master),
//                        and deleting main/master on a remote
//   commit-on-main       committing on main/master while the repo has other worktrees (shared main)
//   dirty-main-checkout  checkout/switch/stash/pull/reset --hard/clean -f in the main checkout while
//                        it has dirty files this session didn't write
//   junction-delete      git worktree remove, rm -r or Remove-Item -Recurse on a folder that holds a
//                        junction or symlink (node_modules linked into another checkout)
//   merge-gate (opt-in)  gh pr merge unless the owner wrote "approve merge #N" in this session and
//                        every check on #N is green ("approve merge #N anyway" skips the checks);
//                        --admin is always refused. Pair it with a permission rule that allows
//                        `gh pr merge`, so an approved, green merge needs no hand-typed command.
//
// A UserPromptSubmit hook records the owner's merge approvals in the session ledger. The hook fails
// open: any error lets the command run, except that an unverifiable merge-gate check denies.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RULES = ["no-verify", "force-push", "commit-on-main", "dirty-main-checkout", "junction-delete", "merge-gate"];
export const OPT_IN = ["merge-gate"];
const MAIN = new Set(["main", "master"]);
const LEDGER_DAYS = 7;

export const guardHome = (env = process.env) => env.GIT_GUARD_HOME || path.join(homedir(), ".claude", "git-guard");

// Git Bash paths (/c/Users/x) and ~ to native paths.
export function nativePath(p, cwd) {
  if (!p) return cwd;
  let out = p;
  if (out === "~" || out.startsWith("~/") || out.startsWith("~\\")) out = path.join(homedir(), out.slice(1));
  if (process.platform === "win32") {
    const m = /^\/([a-zA-Z])(\/|$)/.exec(out);
    if (m) out = `${m[1].toUpperCase()}:/${out.slice(3)}`;
  }
  return path.resolve(cwd, out);
}

// Splits a shell line into segments at unquoted && || ; | & and newlines, and each segment into
// words with quotes removed. Good enough for the commands an agent writes; not a full shell parser.
export function segments(command) {
  const out = [];
  let words = [];
  let word = "";
  let quote = null;
  let started = false;
  const endWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && /["\\$`]/.test(command[i + 1] ?? "")) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < command.length && command[i + 1] !== "\n" && process.platform !== "win32") {
      word += command[++i];
      started = true;
    } else if (c === "\n" || c === ";" || c === "|" || c === "&") {
      if ((c === "|" || c === "&") && command[i + 1] === c) i++;
      endSegment();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word += c;
      started = true;
    }
  }
  endSegment();
  return out;
}

const base = (w) => path.basename(w.replace(/\\/g, "/")).toLowerCase().replace(/\.(exe|cmd|bat)$/, "");

function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 8000, windowsHide: true });
  return r.status === 0 ? r.stdout : null;
}

// Facts about the repo at dir, or null outside a repo.
export function repoInfo(dir) {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;
  const list = git(dir, ["worktree", "list", "--porcelain"]) ?? "";
  const worktrees = [...list.matchAll(/^worktree (.+)$/gm)].map((m) => path.resolve(m[1].trim()));
  const toplevel = path.resolve(top.trim());
  const branch = (git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "").trim();
  return { toplevel, main: worktrees[0] ?? toplevel, worktrees, branch, isMain: same(toplevel, worktrees[0] ?? toplevel) };
}

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// The real path, so the edit tools' paths and git's compare equal: Windows 8.3 short names
// (RUNNER~1) become long ones. A file that is gone keeps its name under its real folder.
export function canonical(p) {
  const abs = path.resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    try {
      return path.join(realpathSync.native(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
  }
}

function dirtyFiles(info) {
  const out = git(info.toplevel, ["status", "--porcelain", "-uall"]) ?? "";
  return out.split(/\r?\n/).filter(Boolean).map((l) => {
    const p = l.slice(3).replace(/^"|"$/g, "");
    return canonical(path.resolve(info.toplevel, p.includes(" -> ") ? p.split(" -> ")[1] : p));
  });
}

// --- session ledger: files this session wrote with Edit/Write, and the owner's merge approvals ---

const ledgerPath = (home, session) => path.join(home, "sessions", `${String(session).replace(/[^\w.-]/g, "_")}.json`);

function readLedger(home, session) {
  try {
    const l = JSON.parse(readFileSync(ledgerPath(home, session), "utf8"));
    return { files: l.files ?? [], merges: l.merges ?? [] };
  } catch {
    return { files: [], merges: [] };
  }
}

export function authored(home, session) {
  if (!session) return new Set();
  return new Set(readLedger(home, session).files.map((f) => f.toLowerCase()));
}

// The merges the owner approved in this session: [{ pr, anyway, repo, head }]. An approval holds
// for that repo and that head commit only.
export function approvals(home, session) {
  return session ? readLedger(home, session).merges : [];
}

// The approval must be the whole first line of the owner's message: "approve merge #12",
// "approve merging #12 and #14", "approve merge 12 anyway". Anywhere else (a negation, a question,
// pasted text further down) it is not an approval.
export function parseApprovals(prompt) {
  const first = String(prompt ?? "").replace(/^﻿/, "").trimStart().split(/\r?\n/)[0].trim();
  const m = /^approve\s+merg(?:e|ing)\s+((?:#?\d+(?:\s*(?:,|and|&)\s*)?)+?)(\s+anyway)?\s*[.!]?$/i.exec(first);
  return m ? m[1].match(/\d+/g).map((n) => ({ pr: Number(n), anyway: Boolean(m[2]) })) : [];
}

// owner/name of a GitHub repo from a URL or an owner/name string, lowercased.
export function repoName(value) {
  const m = /(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(value ?? "").trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

const originRepo = (dir) => repoName(git(dir, ["remote", "get-url", "origin"]));

// The PR's head commit and checks, from gh.
function ghView(pr, repo, cwd) {
  const args = ["pr", "view", String(pr), "--json", "headRefOid,statusCheckRollup", ...(repo ? ["--repo", repo] : [])];
  const r = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 10000, windowsHide: true });
  if (r.status !== 0) throw new Error((r.error?.message || r.stderr || `gh exited ${r.status}`).trim().split("\n")[0]);
  const v = JSON.parse(r.stdout);
  return { head: v.headRefOid, rollup: v.statusCheckRollup };
}

function writeLedger(home, session, ledger) {
  const p = ledgerPath(home, session);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ updated: new Date().toISOString(), ...ledger }, null, 1));
  return p;
}

// Records the approvals in the owner's prompt, each bound to the repo at cwd and the PR's current
// head commit (null when gh can't say, which the gate then treats as no approval).
export function approve(home, session, prompt, { cwd = process.cwd(), view = ghView } = {}) {
  const found = parseApprovals(prompt);
  if (!session || !found.length) return [];
  const dir = nativePath(cwd, process.cwd());
  const repo = originRepo(dir);
  const ledger = readLedger(home, session);
  const out = found.map((a) => {
    let head = null;
    try {
      if (repo) head = view(a.pr, repo, dir).head ?? null;
    } catch {
      // recorded without a head; the gate asks for a fresh approval
    }
    return { ...a, repo, head };
  });
  for (const a of out) {
    ledger.merges = ledger.merges.filter((m) => !(m.pr === a.pr && m.repo === a.repo));
    ledger.merges.push(a);
  }
  writeLedger(home, session, ledger);
  return out;
}

export function record(home, session, file) {
  if (!session || !file) return;
  const ledger = readLedger(home, session);
  const abs = canonical(file);
  if (!ledger.files.some((f) => same(f, abs))) ledger.files.push(abs);
  const p = writeLedger(home, session, ledger);
  // Prune old sessions now and then.
  const cutoff = Date.now() - LEDGER_DAYS * 864e5;
  for (const f of readdirSync(path.dirname(p))) {
    const fp = path.join(path.dirname(p), f);
    try {
      if (statSync(fp).mtimeMs < cutoff) rmSync(fp);
    } catch {
      // another session pruned it
    }
  }
}

// The rules switched off for this repo: those in an "allow" list, and opt-in rules not in an
// "enable" list. A repo's own file can't switch off an opt-in rule: the file can arrive in a merged
// PR or be written by the agent the rule is guarding.
function switchedOff(home, info) {
  const read = (file) => {
    if (!file || !existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return {}; // a broken config switches nothing off
    }
  };
  const global = read(path.join(home, "config.json"));
  const local = read(info && path.join(info.main, ".claude", "git-guard.json"));
  const off = new Set([...(global.allow ?? []), ...(local.allow ?? [])].filter((r) => !OPT_IN.includes(r)));
  const enabled = new Set([...(global.enable ?? []), ...(local.enable ?? [])]);
  for (const r of OPT_IN) if (!enabled.has(r) || (global.allow ?? []).includes(r)) off.add(r);
  return off;
}

// --- junction scan ---

// First link (junction or symlink) inside dir, up to 3 levels down, without following links.
export function findLink(dir, depth = 3, budget = { n: 4000 }) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (--budget.n < 0) return null;
    const p = path.join(dir, e.name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) return p;
    if (st.isDirectory() && depth > 1 && ![".git", "node_modules", "target", ".venv"].includes(e.name)) {
      const hit = findLink(p, depth - 1, budget);
      if (hit) return hit;
    }
  }
  return null;
}

function linkVerdict(target) {
  try {
    if (!lstatSync(target).isDirectory()) return null;
  } catch {
    return null;
  }
  const link = findLink(target);
  if (!link) return null;
  const unlink = process.platform === "win32" ? `cmd /c rmdir "${link}"` : `rm "${link}"`;
  return `${target} contains a link (${link}). Deleting through it can wipe the folder it points into, often another checkout's node_modules. Unlink it first with \`${unlink}\` (that removes only the link), then retry.`;
}

// --- the rules ---

function gitParts(words) {
  const opts = { dir: null, config: [] };
  let i = 1;
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === "-C") opts.dir = words[++i];
    else if (w === "-c") opts.config.push(words[++i] ?? "");
    else if (w.startsWith("--git-dir") || w.startsWith("--work-tree") || w.startsWith("--namespace")) {
      if (!w.includes("=")) i++;
    } else if (w.startsWith("-")) continue;
    else break;
  }
  return { ...opts, sub: words[i], args: words.slice(i + 1) };
}

const VALUE_FLAGS = new Set(["-m", "-F", "-c", "-C", "-t", "--message", "--file", "--template", "--author", "--date", "--fixup", "--squash"]);

function checkGit(words, cwd, ctx) {
  const g = gitParts(words);
  const dir = g.dir ? nativePath(g.dir, cwd) : cwd;
  const { sub, args } = g;
  if (!sub) return null;
  const has = (...f) => args.some((a) => f.includes(a));
  const info = () => (ctx.info ??= repoInfo(dir) ?? false) || null;
  const off = (rule) => {
    const i = info();
    return (ctx.allow ??= switchedOff(ctx.home, i)).has(rule);
  };

  // no-verify
  if (["commit", "push", "merge", "rebase", "am", "cherry-pick", "revert"].includes(sub)) {
    let skip = false;
    if (has("--no-verify")) skip = true;
    if (g.config.some((c) => /^core\.hookspath=/i.test(c))) skip = true;
    if (sub === "commit") {
      for (let i = 0; i < args.length; i++) {
        if (VALUE_FLAGS.has(args[i])) i++;
        else if (/^-[a-zA-Z]+$/.test(args[i]) && args[i].includes("n")) skip = true;
      }
    }
    if (skip && !off("no-verify")) return { rule: "no-verify", reason: "Skipping git hooks (--no-verify, -n or core.hooksPath) is not allowed. Fix what the hook reports instead." };
  }

  // force-push and deleting main
  if (sub === "push") {
    const refspecs = args.filter((a) => !a.startsWith("-")).slice(1);
    const lease = args.some((a) => a.startsWith("--force-with-lease") || a.startsWith("--force-if-includes"));
    const hard = args.some((a) => a === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) || refspecs.some((r) => r.startsWith("+"));
    const dest = (r) => r.replace(/^\+/, "").split(":").pop();
    const toMain = refspecs.length ? refspecs.some((r) => MAIN.has(dest(r))) : MAIN.has(info()?.branch ?? "");
    const deletesMain = (has("--delete", "-d") && refspecs.some((r) => MAIN.has(r))) || refspecs.some((r) => /^:/.test(r) && MAIN.has(r.slice(1)));
    if ((hard || (lease && toMain) || deletesMain) && !off("force-push")) {
      if (deletesMain) return { rule: "force-push", reason: "Deleting main/master on a remote is not allowed." };
      if (hard) return { rule: "force-push", reason: "Force-pushing (--force, -f or a +refspec) is not allowed. If you own this branch and must rewrite it, use --force-with-lease." };
      return { rule: "force-push", reason: "Rewriting main/master on a remote is not allowed, even with --force-with-lease." };
    }
  }

  // commit on a shared main
  if (sub === "commit" && !has("--dry-run")) {
    const i = info();
    if (i && MAIN.has(i.branch) && i.worktrees.length > 1 && !off("commit-on-main")) {
      return {
        rule: "commit-on-main",
        reason: `This repo has ${i.worktrees.length} worktrees, so other sessions share ${i.branch}. Commit on a feature branch in your own worktree instead: git worktree add ../${path.basename(i.main)}-<name> -b <type>/<name> origin/${i.branch}`,
      };
    }
  }

  // branch or tree changes in a dirty main checkout
  const stashSafe = sub === "stash" && ["list", "show", "create"].includes(args[0]);
  const risky = ["checkout", "switch", "pull"].includes(sub) || (sub === "stash" && !stashSafe) || (sub === "reset" && has("--hard")) || (sub === "clean" && args.some((a) => /^-[a-zA-Z]*f/.test(a) || a === "--force"));
  if (risky) {
    const i = info();
    if (i && i.isMain && !off("dirty-main-checkout")) {
      const mine = authored(ctx.home, ctx.session);
      const theirs = dirtyFiles(i).filter((f) => !mine.has(f.toLowerCase()));
      if (theirs.length) {
        const shown = theirs.slice(0, 5).map((f) => path.relative(i.toplevel, f).replace(/\\/g, "/")).join(", ");
        return {
          rule: "dirty-main-checkout",
          reason: `The main checkout has ${theirs.length} dirty file(s) this session didn't write (${shown}${theirs.length > 5 ? ", ..." : ""}). A parallel session may own them, and \`git ${sub}\` here can move or lose its work. Work in your own worktree instead: git worktree add ../${path.basename(i.main)}-<name> -b <type>/<name> origin/main. If the files are yours (written with a shell command), commit them first.`,
        };
      }
    }
  }

  // worktree remove through a junction
  if (sub === "worktree" && args[0] === "remove" && !off("junction-delete")) {
    const target = args.slice(1).find((a) => !a.startsWith("-"));
    const why = target && linkVerdict(nativePath(target, dir));
    if (why) return { rule: "junction-delete", reason: why };
  }
  return null;
}

function checkDelete(words, cwd, ctx) {
  const cmd = base(words[0]);
  let targets = [];
  if (cmd === "rm") {
    const flags = words.slice(1).filter((w) => w.startsWith("-"));
    if (!flags.some((f) => f === "--recursive" || /^-[a-zA-Z]*[rR]/.test(f))) return null;
    targets = words.slice(1).filter((w) => !w.startsWith("-"));
  } else if (["remove-item", "ri", "del", "erase", "rd", "rmdir"].includes(cmd)) {
    const rest = words.slice(1);
    const recurse = rest.some((w) => /^-r(ecurse)?$/i.test(w) || /^\/s$/i.test(w));
    if (!recurse) return null;
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i];
      if (/^-(path|literalpath)$/i.test(w)) targets.push(rest[++i]);
      else if (!w.startsWith("-") && !/^\/[a-z]$/i.test(w)) targets.push(w);
    }
  } else return null;
  const off = () => (ctx.allow ??= switchedOff(ctx.home, repoInfo(cwd))).has("junction-delete");
  for (const t of targets) {
    if (!t || /[*?]/.test(t)) continue;
    const why = linkVerdict(nativePath(t.replace(/,$/, ""), cwd));
    if (why && !off()) return { rule: "junction-delete", reason: why };
  }
  return null;
}

// Check runs on a PR, from `gh pr view --json statusCheckRollup`: null when all green, else why not.
export function checksVerdict(rollup) {
  const checks = (rollup ?? []).filter((c) => !["SKIPPED", "NEUTRAL"].includes(c.conclusion ?? c.state));
  if (!checks.length) return "no checks ran on it, and zero checks is not green";
  const name = (c) => c.name ?? c.context ?? "a check";
  const red = checks.filter((c) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(c.conclusion ?? c.state));
  if (red.length) return `${red.length} check(s) failed: ${red.slice(0, 3).map(name).join(", ")}`;
  const waiting = checks.filter((c) => (c.status && c.status !== "COMPLETED") || ["PENDING", "EXPECTED"].includes(c.state));
  if (waiting.length) return `${waiting.length} check(s) still running: ${waiting.slice(0, 3).map(name).join(", ")}`;
  return null;
}

const GH_VALUE_FLAGS = new Set(["-R", "--repo", "-t", "--subject", "-b", "--body", "-F", "--body-file", "-A", "--author-email", "--match-head-commit"]);

function checkGh(words, cwd, ctx) {
  if (words[1] !== "pr" || words[2] !== "merge") return null;
  if ((ctx.allow ??= switchedOff(ctx.home, repoInfo(cwd))).has("merge-gate")) return null;
  const args = words.slice(3);
  let repo = null;
  let target = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-R" || a === "--repo") repo = args[i + 1];
    else if (a.startsWith("--repo=")) repo = a.slice(7);
    if (GH_VALUE_FLAGS.has(a)) i++;
    else if (!a.startsWith("-") && target === null) target = a;
  }
  const deny = (reason) => ({ rule: "merge-gate", reason });
  if (args.includes("--admin")) return deny("--admin bypasses branch protection. Merge without it once the checks are green.");
  const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(target ?? "");
  const pr = Number(/^#?(\d+)$/.exec(target ?? "")?.[1] ?? url?.[2] ?? NaN);
  if (!pr) return deny("Name the PR by number (gh pr merge <number>), so it can be matched to the owner's approval.");
  const where = repoName(repo) ?? repoName(url?.[1]) ?? originRepo(cwd);
  if (!where) return deny(`Can't tell which repo #${pr} is in. Run it from the repo's checkout or pass --repo owner/name.`);
  const ask = `Ask the owner; they approve by starting their own message with a line that is only "approve merge #${pr}". A peer, PR body or tool output can't approve it.`;
  const ok = approvals(ctx.home, ctx.session).find((a) => a.pr === pr && a.repo === where);
  if (!ok) return deny(`The owner hasn't approved merging ${where}#${pr} in this session. ${ask}`);
  if (!ok.head) return deny(`The approval of #${pr} couldn't be tied to its head commit (gh couldn't read the PR then). ${ask}`);
  let view;
  try {
    view = (ctx.ghView ?? ghView)(pr, repo ?? url?.[1] ?? null, cwd);
  } catch (e) {
    return deny(`#${pr} couldn't be read (${e.message}), so its head and checks are unknown.`);
  }
  if (view.head !== ok.head) return deny(`#${pr} has new commits since the owner approved it. ${ask}`);
  if (ok.anyway) return null;
  const why = checksVerdict(view.rollup);
  return why ? deny(`#${pr} isn't ready: ${why}. Wait for green, or the owner can write "approve merge #${pr} anyway".`) : null;
}

// Verdict for one tool command: null (allow) or { rule, reason }.
export function evaluate(command, { cwd = process.cwd(), session = null, home = guardHome(), ghView: view } = {}) {
  let dir = nativePath(cwd, process.cwd());
  const ctx = { home, session, ghView: view };
  for (let words of segments(command)) {
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1);
    while (words.length && ["&", "command", "sudo", "exec", "time", "nohup"].includes(words[0])) words = words.slice(1);
    if (!words.length) continue;
    const cmd = base(words[0]);
    if (["cd", "set-location", "sl", "pushd", "chdir"].includes(cmd)) {
      const to = words.slice(1).find((w) => !w.startsWith("-") || w === "-");
      if (to && to !== "-") dir = nativePath(to, dir);
      continue;
    }
    const verdict = cmd === "git" ? checkGit(words, dir, ctx) : cmd === "gh" ? checkGh(words, dir, ctx) : checkDelete(words, dir, ctx);
    if (verdict) return verdict;
    if (cmd === "git") ctx.info = undefined; // a later segment may run elsewhere
  }
  return null;
}

// The hook's JSON, minus a byte-order mark (Windows PowerShell 5.1 adds one when it pipes text).
export const parseHookInput = (raw) => JSON.parse(String(raw ?? "").replace(/^﻿/, "") || "{}");

function hook(raw) {
  const input = parseHookInput(raw);
  const home = guardHome();
  const event = input.hook_event_name;
  const tool = input.tool_name ?? "";
  if (event === "UserPromptSubmit") {
    approve(home, input.session_id, input.prompt, { cwd: input.cwd ?? process.cwd() });
    return;
  }
  if (event === "PostToolUse") {
    const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) && file) record(home, input.session_id, nativePath(file, input.cwd ?? process.cwd()));
    return;
  }
  if (event !== "PreToolUse" || !/^(Bash|PowerShell)$/.test(tool)) return;
  const verdict = evaluate(String(input.tool_input?.command ?? ""), { cwd: input.cwd ?? process.cwd(), session: input.session_id, home });
  if (!verdict) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `git-guard (${verdict.rule}): ${verdict.reason}`,
    },
  }));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "check") {
      const opts = {};
      let i = 0;
      for (; i < rest.length && rest[i] !== "--"; i++) {
        if (rest[i] === "--cwd") opts.cwd = path.resolve(rest[++i]);
        else if (rest[i] === "--session") opts.session = rest[++i];
      }
      const v = evaluate(rest.slice(i + 1).join(" "), opts);
      console.log(v ? `deny (${v.rule}): ${v.reason}` : "allow");
    } else if (cmd === "status") {
      const home = guardHome();
      console.log(`ledger: ${path.join(home, "sessions")}\nglobal config: ${path.join(home, "config.json")}\nper-repo config: <main checkout>/.claude/git-guard.json\nrules: ${RULES.join(", ")} (opt-in: ${OPT_IN.join(", ")})`);
    } else if (cmd === "--self-test") {
      // An empty home and a cwd outside any repo, so no config can switch the rule off.
      const v = evaluate("git push --force origin main", { cwd: tmpdir(), home: path.join(tmpdir(), "git-guard-self-test") });
      if (v?.rule !== "force-push") throw new Error("a force-push to main was not denied");
      console.log("ok git-guard");
    } else {
      let raw = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d) => (raw += d));
      process.stdin.on("end", () => {
        try {
          hook(raw);
        } catch {
          // fail open
        }
      });
    }
  } catch (e) {
    if (cmd === "check" || cmd === "status" || cmd === "--self-test") {
      console.error(e.message);
      process.exit(1);
    }
  }
}
