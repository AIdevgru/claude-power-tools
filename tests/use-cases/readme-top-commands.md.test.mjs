// Use case: tests/use-cases/readme-top-commands.md
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Skill folders, in either layout: skills/<name> or plugins/<plugin>/skills/<name>.
function skillFiles() {
  const out = new Map();
  const scan = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name, "SKILL.md");
      if (e.isDirectory() && existsSync(f)) out.set(e.name, f);
    }
  };
  scan(path.join(ROOT, "skills"));
  const plugins = path.join(ROOT, "plugins");
  if (existsSync(plugins)) for (const p of readdirSync(plugins)) scan(path.join(plugins, p, "skills"));
  return out;
}

// Bare words that select a mode rather than name a value.
const SUBCOMMANDS = new Set(["line", "prs", "actions", "quick", "all", "status", "board", "send", "init", "watch", "now",
  "check", "allow", "deny", "enable", "disable", "merge-gate", "resume", "once", "manual", "auto", "list", "scan"]);

const hint = (file) => /^argument-hint:\s*"?(.*?)"?\s*$/m.exec(readFileSync(file, "utf8"))?.[1] ?? "";

function topCommands() {
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
  const section = /## Top commands\n([\s\S]*?)\n## /.exec(readme)?.[1];
  assert.ok(section, "README has a Top commands section");
  const blocks = [...section.matchAll(/```text\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 4, "Top commands has its code blocks");
  return blocks.join("\n").split("\n").filter((l) => l.startsWith("/")).map((l) => l.split(/\s{2,}/)[0].trim());
}

test("every README top command names a real skill, and every switch it shows is in the skill's argument-hint", () => {
  const skills = skillFiles();
  const commands = topCommands();
  assert.ok(commands.length >= 15, `found ${commands.length} commands`);
  for (const cmd of commands) {
    const words = cmd.replace(/"[^"]*"/g, "").split(/\s+/).filter(Boolean);
    if (words[0] === "/loop") words.shift();
    const name = words[0].replace(/^\//, "");
    assert.ok(skills.has(name), `${cmd}: no skill named ${name}`);
    const h = hint(skills.get(name));
    for (const w of words.slice(1)) {
      // Switches and subcommands must be in the hint; values (names, numbers, paths, URLs, keys) needn't.
      if (!/^--?[a-z-]+$/.test(w) && !SUBCOMMANDS.has(w)) continue;
      assert.ok(h.includes(w), `${cmd}: "${w}" is not in ${name}'s argument-hint (${h})`);
    }
  }
});
