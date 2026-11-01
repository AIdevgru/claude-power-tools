#!/usr/bin/env node
// Checks that the claude-power-tools hooks installed here actually run. Hooks fail open, so a hook
// that can't start (a broken link, a missing node, a bad path) looks exactly like a hook that found
// nothing to do; this probe tells them apart.
//
//   node doctor.mjs            report every hook and the graphify versions; exit 1 on a problem
//   node doctor.mjs --hook     SessionStart mode: one line only when something is wrong, else silence
//
// Each hook script answers --self-test through the same path its hook command uses (through the
// link, for --link installs). Outside a plugin, the doctor also checks that settings.json registers
// every installed hook script for each event it needs.
import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// skill -> its hook script (relative to the skills folder) and the events it must be registered for.
export const PROBES = {
  "git-guard": { script: "git-guard/scripts/git-guard.mjs", events: ["PreToolUse", "PostToolUse", "UserPromptSubmit"] },
  "fleet-manager": { script: "fleet-manager/scripts/debounce.mjs", events: ["UserPromptSubmit", "PreToolUse"] },
  "request-inbox": { script: "request-inbox/scripts/inbox.mjs", events: ["SessionStart"] },
  project: { script: "project/scripts/projects.mjs", events: ["SessionStart"] },
  "usage-handoff": { script: "usage-handoff/scripts/usage.mjs", events: ["UserPromptSubmit", "PostToolUse"] },
};

const slash = (p) => p.replace(/\\/g, "/");

// The hook commands registered for one event, or for every event when event is omitted.
export function hookCommands(settings, event) {
  const groups = event ? settings?.hooks?.[event] ?? [] : Object.values(settings?.hooks ?? {}).flat();
  return groups.flatMap((g) => (g.hooks ?? []).map((h) => slash(String(h.command ?? ""))));
}

// Problems with the hooks under skillsDir: [{ skill, problem }]. settings = null skips the
// registration check (plugin installs register hooks through the plugin's hooks.json). The probes
// run in parallel, so a SessionStart doctor costs one probe's time, not five.
export async function diagnose(skillsDir, settings, run = selfTest) {
  const installed = Object.entries(PROBES).filter(([skill]) => existsSync(path.join(skillsDir, skill)));
  const results = await Promise.all(installed.map(([, p]) => run(path.join(skillsDir, p.script))));
  const out = [];
  installed.forEach(([skill, { script, events }], i) => {
    if (!results[i].ok) return void out.push({ skill, problem: `its hook script doesn't run (${results[i].detail})` });
    const missing = settings ? events.filter((e) => !hookCommands(settings, e).some((c) => c.includes(`/${script}`))) : [];
    if (missing.length) out.push({ skill, problem: `its hook isn't registered in settings.json for ${missing.join(", ")}` });
  });
  return out;
}

export function selfTest(file) {
  return new Promise((resolve) => {
    execFile(process.execPath, [file, "--self-test"], { encoding: "utf8", timeout: 10_000, windowsHide: true }, (err, stdout, stderr) => {
      if (!err && /^ok\b/m.test(stdout ?? "")) return resolve({ ok: true });
      // Node prints the failing source line first; the line naming the error says more.
      const lines = (stderr || stdout || err?.message || "").trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const detail = lines.find((l) => /^\w*Error\b/.test(l)) ?? lines[0];
      resolve({ ok: false, detail: detail || "no output" });
    });
  });
}

// Plugin installs register their hooks through the plugin's hooks.json, not settings.json. Plugin
// hooks get CLAUDE_PLUGIN_ROOT, and a plugin's files live in Claude Code's plugin cache (for
// /update runs). A clone's own plugins/<name>/skills folder is not a plugin install. Each plugin
// probes only its own skills: the power-tools doctor can't see power-tools-projects' hook.
export const isPlugin = (skillsDir, env = process.env) => Boolean(env.CLAUDE_PLUGIN_ROOT) || /[\\/]plugins[\\/](?:cache|marketplaces)[\\/]/.test(skillsDir);

const cmp = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

// One line when the graphify CLI and the bundled skill disagree, else null. Both directions matter:
// an older CLI lacks what the skill calls, and a newer one warns on every call.
export function graphifyDrift(cli, skill) {
  if (!cli || !skill || cmp(cli, skill) === 0) return null;
  if (cmp(cli, skill) < 0) return `graphify CLI ${cli} is older than the bundled skill ${skill}: uv tool upgrade graphifyy  (or: pipx upgrade graphifyy)`;
  return `graphify CLI ${cli} is newer than the bundled skill ${skill}, so graphify warns on every call. Run /update for a newer bundle; if there isn't one yet, a maintainer runs: node scripts/vendor.mjs sync graphify --ref v${cli}`;
}

function graphifyVersions(skillsDir) {
  const file = path.join(skillsDir, "graphify", ".graphify_version");
  if (!existsSync(file)) return { cli: null, skill: null };
  const r = spawnSync("graphify", ["--version"], { encoding: "utf8", timeout: 20_000, windowsHide: true });
  const cli = r.status === 0 ? /(\d+\.\d+\.\d+)/.exec(`${r.stdout} ${r.stderr}`)?.[1] ?? null : null;
  return { cli, skill: readFileSync(file, "utf8").trim() };
}

function readSettings(target) {
  try {
    return JSON.parse(readFileSync(path.join(target, "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

// The skills folder as the hooks see it: the path this script was started with, not its real path,
// so a --link install is probed through its links.
export function skillsDirFor(argv1 = process.argv[1], env = process.env) {
  if (env.CLAUDE_PLUGIN_ROOT) return path.join(env.CLAUDE_PLUGIN_ROOT, "skills");
  return path.resolve(path.dirname(argv1), "..", "..");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const hookMode = process.argv.includes("--hook");
  try {
    const skillsDir = skillsDirFor();
    const target = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
    const problems = await diagnose(skillsDir, isPlugin(skillsDir) ? null : readSettings(target));
    const list = problems.map((p) => `${p.skill}: ${p.problem}`);
    if (hookMode) {
      if (list.length) console.log(`claude-power-tools doctor: ${list.length} hook problem(s): ${list.join("; ")}. These hooks are doing nothing. Tell the owner, and suggest /update --force (or re-running the installer), then /hooks.`);
    } else {
      const checked = Object.keys(PROBES).filter((s) => existsSync(path.join(skillsDir, s)));
      console.log(list.length ? `Hook problems:\n${list.map((l) => `  ${l}`).join("\n")}` : `All ${checked.length} hooks respond (${checked.join(", ")}).`);
      const v = graphifyVersions(skillsDir);
      const drift = graphifyDrift(v.cli, v.skill);
      if (drift) console.log(drift);
      if (list.length) process.exitCode = 1;
    }
  } catch (e) {
    // A SessionStart hook must never block a session.
    if (!hookMode) {
      console.error(`doctor failed: ${e.message}`);
      process.exitCode = 1;
    }
  }
}
