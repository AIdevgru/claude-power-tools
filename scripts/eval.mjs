#!/usr/bin/env node
// Runs the trigger evals of every plugin (plugins/<plugin>/evals/triggers/) with `claude plugin eval`.
// Each plugin is evaluated on its own, because a plugin only loads its own skills.
//
//   node scripts/eval.mjs [plugin...] [-- extra claude plugin eval options]
//
// With no plugin names it runs all of them. It costs model calls, so it isn't part of npm test.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGINS, REPO, pluginDir } from "./layout.mjs";

// The `claude plugin eval` argument lists for the named plugins (default: every plugin with evals).
export function evalRuns(argv, root = REPO) {
  const cut = argv.indexOf("--");
  const names = cut === -1 ? argv : argv.slice(0, cut);
  const extra = cut === -1 ? [] : argv.slice(cut + 1);
  const unknown = names.filter((n) => !Object.hasOwn(PLUGINS, n));
  if (unknown.length) throw new Error(`unknown plugin(s): ${unknown.join(", ")}. Plugins: ${Object.keys(PLUGINS).join(", ")}`);
  return (names.length ? names : Object.keys(PLUGINS))
    .filter((p) => existsSync(path.join(pluginDir(p, root), "evals")))
    .map((p) => ["plugin", "eval", PLUGINS[p].dir, "--tag", "trigger", "--ablation", "none", ...extra]);
}

// One argument quoted for cmd.exe running a .cmd shim: inside double quotes cmd's & | < > ^ and
// spaces are plain text, and trailing backslashes are doubled so they don't escape the closing
// quote. cmd expands %VAR% even inside quotes, and an inner quote would end the quoting, so an
// argument with % or " is refused rather than passed wrong.
export function cmdQuote(arg) {
  if (/[%"\r\n]/.test(arg)) throw new Error(`can't pass ${JSON.stringify(arg)} through cmd.exe`);
  return `"${arg.replace(/(\\+)$/, "$1$1")}"`;
}

// How to spawn `claude args` without a shell where possible. On Windows the CLI is claude.exe
// (native install) or claude.cmd (npm), found on PATH with PATHEXT; an .exe runs directly, and a
// .cmd, which Node only starts through cmd.exe, gets one command line of quoted arguments (no
// args array with shell: true, which splits arguments with spaces and is deprecated, DEP0190).
export function claudeCommand(args, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== "win32") return { file: "claude", args, shell: false };
  const exts = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase());
  for (const dir of (env.PATH || env.Path || "").split(";").filter(Boolean)) {
    for (const ext of exts) {
      const file = path.win32.join(dir, `claude${ext}`);
      if (!exists(file)) continue;
      if (ext === ".exe" || ext === ".com") return { file, args, shell: false };
      return { file: [cmdQuote(file), ...args.map(cmdQuote)].join(" "), args: [], shell: true };
    }
  }
  throw new Error("claude is not on PATH");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    let failed = 0;
    for (const args of evalRuns(process.argv.slice(2))) {
      console.log(`\n> claude ${args.join(" ")}`);
      const cmd = claudeCommand(args);
      const r = spawnSync(cmd.file, cmd.args, { cwd: REPO, stdio: "inherit", shell: cmd.shell });
      if (r.status !== 0) failed++;
    }
    process.exit(failed ? 1 : 0);
  } catch (e) {
    console.error(`eval failed: ${e.message}`);
    process.exit(1);
  }
}
