#!/usr/bin/env node
// Debounce for /fleet-manager. Two modes:
//
//   Hook mode (no CLI args): reads Claude Code hook JSON on stdin. Handles
//   UserPromptSubmit (a typed or cron-fired "/fleet-manager ...") and PreToolUse on
//   Skill (tool_input.skill === "fleet-manager", e.g. from a dynamic /loop). It skips
//   the tick when the manager ran moments ago, or when the last tick reported
//   the work quiet/done and nothing has changed since. Quiet checks back off
//   exponentially; any new work resets the backoff.
//
//   CLI mode: `node debounce.mjs record active|quiet|done` at the end of a tick
//   snapshots the work fingerprint so the next check compares against the
//   post-tick state. `status` prints the state; `reset` clears it.
//
// Configuration (all optional):
//   FLEET_MANAGER_REPO   owner/name of the GitHub repo (default: `gh repo view` in the project dir)
//   FLEET_MANAGER_INBOX  request-inbox folder to fingerprint (default: .claude-inbox or .ForClaude in the main checkout)
//   FLEET_MANAGER_HOME   state root (default: ~/.claude/fleet-manager); state is kept per repo
//
// Fails open: any error lets the tick run.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_NAME = "fleet-manager";
export const MIN_INTERVAL_MS = 10 * 60_000; // "the user just ran it"
export const BASE_BACKOFF_MS = 30 * 60_000;
export const MAX_BACKOFF_MS = 4 * 60 * 60_000;
const SCRIPT = fileURLToPath(import.meta.url).replace(/\\/g, "/");
const NOT_REQUESTS = new Set(["README.md", "TEMPLATE.md"]);

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const local = (ms) => {
  try {
    return new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" });
  } catch {
    return iso(ms);
  }
};

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

export function resolveRepo(cwd = projectDir()) {
  if (process.env.FLEET_MANAGER_REPO) return process.env.FLEET_MANAGER_REPO;
  return run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd);
}

// The main checkout's inbox, also from a worktree. Requests sit either in
// <inbox>/inbox/ or directly in <inbox>/.
export function resolveInbox(cwd = projectDir()) {
  if (process.env.FLEET_MANAGER_INBOX) return process.env.FLEET_MANAGER_INBOX;
  let main = cwd;
  try {
    main = dirname(run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd));
  } catch {
    // not a git repo: look next to cwd
  }
  const root = [join(main, ".claude-inbox"), join(main, ".ForClaude")].find((d) => existsSync(d));
  if (!root) return null;
  const nested = join(root, "inbox");
  return existsSync(nested) ? nested : root;
}

export function stateFile(repo) {
  const home = process.env.FLEET_MANAGER_HOME || join(homedir(), ".claude", "fleet-manager");
  const slug = (repo || "unknown-repo").replace(/[^A-Za-z0-9._-]+/g, "-");
  return join(home, slug, "debounce.json");
}

export function loadState(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}

function gh(args, cwd) {
  return JSON.parse(run("gh", args, cwd) || "null");
}

// What the manager acts on: open PR heads and their CI state, main's latest
// CI run, and the request inbox. Peer messages wake the session on their own.
export function fingerprint(repo, inbox, cwd = projectDir()) {
  const prs = (gh([
    "pr", "list", "-R", repo, "--state", "open", "--limit", "100",
    "--json", "number,headRefOid,isDraft,reviewDecision,statusCheckRollup",
  ], cwd) ?? []).map((pr) => {
    const checks = {};
    for (const c of pr.statusCheckRollup ?? []) {
      const s = (c.conclusion || c.status || c.state || "UNKNOWN").toUpperCase();
      checks[s] = (checks[s] ?? 0) + 1;
    }
    // mergeable is left out: GitHub computes it lazily (UNKNOWN, then MERGEABLE),
    // and conflicts follow main moving, which main's CI run already captures.
    return { n: pr.number, head: pr.headRefOid, draft: pr.isDraft, r: pr.reviewDecision, checks };
  }).sort((a, b) => a.n - b.n);

  const main = (gh(["run", "list", "-R", repo, "--branch", "main", "--limit", "1", "--json", "headSha,status,conclusion"], cwd) ?? [])[0] ?? null;
  return hashParts({ prs, main, inbox: listInbox(inbox) });
}

export function listInbox(inbox) {
  if (!inbox || !existsSync(inbox) || !statSync(inbox).isDirectory()) return [];
  return readdirSync(inbox).filter((f) => f.endsWith(".md") && !NOT_REQUESTS.has(f)).sort();
}

export function hashParts(parts) {
  const hash = createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 12);
  return { hash, parts };
}

export function describeChange(before, after) {
  if (!before) return "no earlier snapshot";
  const out = [];
  const old = new Map((before.prs ?? []).map((p) => [p.n, JSON.stringify(p)]));
  const cur = new Map((after.prs ?? []).map((p) => [p.n, JSON.stringify(p)]));
  for (const [n, v] of cur) if (!old.has(n)) out.push(`#${n} opened`); else if (old.get(n) !== v) out.push(`#${n} changed`);
  for (const n of old.keys()) if (!cur.has(n)) out.push(`#${n} closed/merged`);
  if (JSON.stringify(before.main) !== JSON.stringify(after.main)) out.push("main CI changed");
  if (JSON.stringify(before.inbox) !== JSON.stringify(after.inbox)) out.push("inbox changed");
  return out.slice(0, 6).join(", ") || "changed";
}

// Arguments that make the run explicit: anything other than "once" bypasses
// the debounce (--force, --help, --deploy, focus arguments).
export function bypasses(args) {
  return args.trim().split(/\s+/).filter(Boolean).some((w) => w !== "once");
}

const isOurSkill = (name) => name === SKILL_NAME || (typeof name === "string" && name.endsWith(`:${SKILL_NAME}`));

// Returns the skill arguments when this hook input is a /fleet-manager invocation, else null.
export function parseInvocation(input) {
  if (input.hook_event_name === "UserPromptSubmit") {
    const m = /^\s*\/(?:[\w.-]+:)?fleet-manager(?:\s+([\s\S]*))?$/.exec(input.prompt ?? "");
    return m ? (m[1] ?? "") : null;
  }
  if (input.hook_event_name === "PreToolUse" && isOurSkill(input.tool_input?.skill)) {
    return input.tool_input?.args ?? "";
  }
  return null;
}

// Pure decision. `getFingerprint` is only called when the backoff has expired.
export function decide(args, state, now, getFingerprint) {
  const next = { ...state };
  if (bypasses(args)) {
    if (/(^|\s)--force(\s|$)/.test(args) || !/--help|-\?|--deploy/.test(args)) {
      Object.assign(next, { lastRunAt: now, status: "running" });
    }
    return { run: true, why: "explicit arguments bypass the debounce", state: next };
  }

  // A tick's end (recordedAt) counts as a run too: prompts queued while the
  // session was busy are judged when they fire, long after their own start.
  const lastActivity = Math.max(state.lastRunAt ?? 0, state.recordedAt ?? 0);
  if (lastActivity && now - lastActivity < MIN_INTERVAL_MS) {
    return { run: false, why: `the manager ran at ${local(lastActivity)}, under ${MIN_INTERVAL_MS / 60_000} min ago`, state };
  }

  if (state.status !== "quiet" && state.status !== "done") {
    Object.assign(next, { lastRunAt: now, status: "running" });
    return { run: true, why: "the last tick left work in flight", state: next };
  }

  if (state.nextCheckAt && now < state.nextCheckAt) {
    return { run: false, why: `work was ${state.status} at ${local(state.recordedAt)}; backing off until ${local(state.nextCheckAt)}`, state };
  }

  const fp = getFingerprint();
  if (fp.hash !== state.fingerprint) {
    const change = describeChange(state.parts, fp.parts);
    Object.assign(next, { lastRunAt: now, status: "running", backoffMs: BASE_BACKOFF_MS, nextCheckAt: 0 });
    return { run: true, why: `new work: ${change}; backoff reset`, state: next };
  }

  const backoffMs = Math.min((state.backoffMs ?? BASE_BACKOFF_MS) * 2, MAX_BACKOFF_MS);
  Object.assign(next, { backoffMs, nextCheckAt: now + backoffMs, lastCheckAt: now });
  return { run: false, why: `nothing changed since the ${state.status} tick at ${local(state.recordedAt)}; next check after ${local(next.nextCheckAt)}`, state: next };
}

export function hookOutput(input, decision, now) {
  if (decision.run) {
    const ctx = `/fleet-manager debounce: running (${decision.why}). At the end of this tick run \`node "${SCRIPT}" record <active|quiet|done>\`.`;
    return { hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: ctx } };
  }
  const reason = `/fleet-manager skipped by debounce: ${decision.why}. Use \`/fleet-manager --force\` to run anyway.`;
  if (input.hook_event_name === "UserPromptSubmit") return { decision: "block", reason };
  const st = decision.state;
  const wait = st.nextCheckAt && st.nextCheckAt > now ? Math.round((st.nextCheckAt - now) / 1000) : 1800;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${reason} Don't run a tick. If this is a dynamic /loop, call ScheduleWakeup with the same prompt, delaySeconds ${Math.min(Math.max(wait, 60), 3600)}, noop true.`,
    },
  };
}

function hookMain(input) {
  const args = parseInvocation(input);
  if (args === null) return;
  const now = Date.now();
  const repo = resolveRepo();
  const file = stateFile(repo);
  const d = decide(args, loadState(file), now, () => fingerprint(repo, resolveInbox()));
  if (d.state !== undefined) saveState(file, d.state);
  process.stdout.write(JSON.stringify(hookOutput(input, d, now)));
}

function cliMain([cmd, arg]) {
  const now = Date.now();
  const repo = resolveRepo();
  const file = stateFile(repo);
  const state = loadState(file);
  if (cmd === "record") {
    if (!["active", "quiet", "done"].includes(arg)) throw new Error("usage: record active|quiet|done");
    const fp = fingerprint(repo, resolveInbox());
    const quiet = arg !== "active";
    Object.assign(state, {
      status: arg, recordedAt: now, fingerprint: fp.hash, parts: fp.parts,
      backoffMs: BASE_BACKOFF_MS, nextCheckAt: quiet ? now + BASE_BACKOFF_MS : 0,
    });
    saveState(file, state);
    console.log(`recorded ${arg} at ${iso(now)} for ${repo} (fingerprint ${fp.hash}${quiet ? `, next check after ${local(state.nextCheckAt)}` : ""})`);
  } else if (cmd === "status") {
    const { parts, ...rest } = state;
    console.log(JSON.stringify({
      repo, file, ...rest,
      lastRunAt: rest.lastRunAt && iso(rest.lastRunAt), recordedAt: rest.recordedAt && iso(rest.recordedAt),
      nextCheckAt: rest.nextCheckAt ? iso(rest.nextCheckAt) : 0,
    }, null, 2));
  } else if (cmd === "reset") {
    saveState(file, {});
    console.log(`debounce state cleared for ${repo}`);
  } else {
    throw new Error("usage: debounce.mjs [record active|quiet|done | status | reset]");
  }
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const cli = process.argv.slice(2);
  if (cli[0] === "--self-test") {
    console.log("ok fleet-manager debounce");
  } else if (cli.length) {
    try {
      cliMain(cli);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  } else {
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        hookMain(JSON.parse(raw.replace(/^﻿/, "") || "{}"));
      } catch (e) {
        process.stderr.write(`fleet-manager debounce failed open: ${e.message}\n`);
      }
      process.exit(0);
    });
  }
}
