#!/usr/bin/env node
// Lists a repo's Claude request inbox: pending requests (urgent first, then oldest by file
// name), the ones already claimed, and the ones waiting on the owner. See ../reference/protocol.md.
//
//   node inbox.mjs            list the inbox (always prints one status block, exits 0)
//   node inbox.mjs --hook     SessionStart hook mode: prints nothing when the repo has no inbox
//   node inbox.mjs init       create the inbox folder with README, TEMPLATE and .gitignore
//   node inbox.mjs path       print the resolved inbox folder
//
// The inbox lives in the repo's MAIN checkout, also when run from a worktree:
//   CLAUDE_INBOX_DIR (override) > <main>/.claude-inbox > <main>/.ForClaude (legacy name)
// Requests sit in <inbox>/inbox/ when that folder exists, otherwise directly in <inbox>/.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOT_REQUESTS = new Set(["README.md", "TEMPLATE.md"]);
export const DEFAULT_NAME = ".claude-inbox";
export const LEGACY_NAME = ".ForClaude";

export function mainCheckout(cwd) {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return path.dirname(commonDir);
  } catch {
    return cwd;
  }
}

// Returns { root, exists }.
export function resolveInbox(cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd(), env = process.env) {
  if (env.CLAUDE_INBOX_DIR) return { root: env.CLAUDE_INBOX_DIR, exists: existsSync(env.CLAUDE_INBOX_DIR) };
  const main = mainCheckout(cwd);
  for (const name of [DEFAULT_NAME, LEGACY_NAME]) {
    const root = path.join(main, name);
    if (existsSync(root)) return { root, exists: true };
  }
  return { root: path.join(main, DEFAULT_NAME), exists: false };
}

// Reads priority and claim from YAML front matter or from Markdown lines
// (`**Priority:** urgent`, `> Claimed by <name> at <time>`).
export function requestMeta(text) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const field = (name) => new RegExp(`^${name}:\\s*([^#\\r\\n]*)`, "mi").exec(block)?.[1]?.trim() ?? "";
  const priority = (field("priority") || /\*\*Priority:\*\*\s*([A-Za-z]+)/i.exec(text)?.[1] || "normal").toLowerCase();
  const claims = [...text.matchAll(/^>\s*Claimed by\s+(\S+)/gim)].map((m) => m[1]);
  return {
    priority,
    deliverable: field("deliverable"),
    claimedBy: field("claimed-by") || claims.at(-1) || "",
  };
}

export function listRequests(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md") && !NOT_REQUESTS.has(e.name))
      .map((e) => ({ name: e.name, ...requestMeta(readFileSync(path.join(dir, e.name), "utf8")) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function snapshot(root) {
  const nested = path.join(root, "inbox");
  const prefix = existsSync(nested) ? "inbox/" : "";
  const pending = listRequests(prefix ? nested : root).sort(
    (a, b) => Number(b.priority === "urgent") - Number(a.priority === "urgent") || a.name.localeCompare(b.name),
  );
  const inProgress = listRequests(path.join(root, "in-progress"));
  // needs-owner/ is the default; any other needs-* folder (from older setups) counts too.
  let waitingDirs = [];
  try {
    waitingDirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith("needs-")).map((e) => e.name);
  } catch {
    // no inbox yet
  }
  const waiting = waitingDirs.flatMap((d) => listRequests(path.join(root, d)).map((r) => ({ ...r, folder: d })));
  return { prefix, pending, inProgress, waiting };
}

export function render(root, { prefix, pending, inProgress, waiting }) {
  const lines = [];
  if (pending.length === 0 && inProgress.length === 0) {
    lines.push(`Claude inbox (${root}): no pending requests.`);
  } else {
    lines.push(`Claude inbox (${root}):`);
    if (pending.length) {
      lines.push(`  ${pending.length} pending request(s), in handling order. Follow the inbox protocol (request-inbox skill):`);
      for (const r of pending) {
        const details = [`priority: ${r.priority}`, r.deliverable && `deliverable: ${r.deliverable}`].filter(Boolean);
        lines.push(`    - ${prefix}${r.name} (${details.join(", ")})`);
      }
    }
    if (inProgress.length) {
      lines.push("  in-progress/ (claimed; leave alone unless the claim is yours or stale):");
      for (const r of inProgress) lines.push(`    - in-progress/${r.name} (claimed by ${r.claimedBy || "unknown"})`);
    }
  }
  if (waiting.length) {
    lines.push(`  waiting on the owner, do not act: ${waiting.map((r) => `${r.folder}/${r.name}`).join(", ")}`);
  }
  return lines.join("\n");
}

export function init(root) {
  mkdirSync(root, { recursive: true });
  const created = [];
  for (const [src, dest] of [["README.md", "README.md"], ["TEMPLATE.md", "TEMPLATE.md"], ["gitignore", ".gitignore"]]) {
    const target = path.join(root, dest);
    if (existsSync(target)) continue;
    copyFileSync(path.join(HERE, "..", "templates", src), target);
    created.push(dest);
  }
  return created;
}

function main(argv) {
  const cmd = argv[0];
  if (cmd === "--self-test") return console.log("ok request-inbox");
  const { root, exists } = resolveInbox();
  if (cmd === "path") {
    console.log(root);
  } else if (cmd === "init") {
    const created = init(root);
    console.log(created.length ? `Initialized ${root} (${created.join(", ")}). Commit README.md, TEMPLATE.md and .gitignore; requests stay untracked.` : `${root} already set up.`);
  } else if (cmd === "--hook") {
    if (exists) console.log(render(root, snapshot(root)));
  } else if (!cmd) {
    console.log(exists ? render(root, snapshot(root)) : `Claude inbox (${root}): not set up. Run \`node ${HERE.replace(/\\/g, "/")}/inbox.mjs init\` to create it.`);
  } else {
    console.error("usage: inbox.mjs [--hook | init | path]");
    process.exitCode = 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    // A hook must never block a session start.
    console.log(`Claude inbox: could not be read (${e.message}).`);
  }
}
