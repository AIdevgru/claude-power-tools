#!/usr/bin/env node
// Copies files that several skills share from their canonical skill to the others, because an
// installed skill can only read files inside its own folder.
//
//   node scripts/sync-shared.mjs           copy
//   node scripts/sync-shared.mjs --check   exit 1 if a copy differs (used by the tests)
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, skillMap } from "./layout.mjs";

export const SHARED = [
  { file: "reference/delivery-rules.md", from: "implement-to-pr", to: ["finish-pr", "ticket-to-pr"] },
];

// Copies that are missing or differ from their canonical file, as repo-relative paths.
export function stale(root = REPO) {
  const skills = skillMap(root);
  const rel = (skill, file) => `${skills[skill].dir}/${file}`;
  const out = [];
  for (const { file, from, to } of SHARED) {
    const canonical = readFileSync(path.join(root, rel(from, file)), "utf8");
    for (const skill of to) {
      const p = path.join(root, rel(skill, file));
      if (!existsSync(p) || readFileSync(p, "utf8") !== canonical) out.push({ from: rel(from, file), to: rel(skill, file) });
    }
  }
  return out;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const diff = stale();
  if (process.argv.includes("--check")) {
    for (const d of diff) console.error(`${d.to} differs from ${d.from}`);
    process.exit(diff.length ? 1 : 0);
  }
  for (const d of diff) {
    mkdirSync(path.dirname(path.join(REPO, d.to)), { recursive: true });
    copyFileSync(path.join(REPO, d.from), path.join(REPO, d.to));
    console.log(`copied ${d.from} -> ${d.to}`);
  }
  if (!diff.length) console.log("shared files are in sync");
}
