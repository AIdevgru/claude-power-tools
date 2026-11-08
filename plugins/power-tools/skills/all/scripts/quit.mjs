#!/usr/bin/env node
// Closes the Claude Code session that ran this script, and nothing else.
//
//   node quit.mjs              end this session a few seconds from now
//   node quit.mjs --dry-run    only print the process it would end
//
// It walks up from its own process to the first ancestor that is Claude Code, so it can only
// ever end the session it runs in. It never matches processes by name across the machine. The
// end happens in a detached helper after a short delay, so the tool call returns and the turn
// can finish first. Exit 2 means no Claude process was found, and nothing was ended.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash", "pwsh", "powershell", "cmd", "conhost", "wsl"]);

const base = (name) => path.basename(String(name || "").replace(/\\/g, "/")).replace(/\.exe$/i, "").toLowerCase();

// A process is Claude Code if its program is `claude`, or it's node running the claude-code package
// or a `claude` launcher. Shells are never Claude, whatever their command line mentions.
export function isClaude({ name, cmd }) {
  const prog = base(name);
  if (SHELLS.has(prog)) return false;
  if (prog === "claude") return true;
  if (prog !== "node" && prog !== "bun") return false;
  const c = String(cmd || "");
  return /@anthropic-ai[\\/]claude-code[\\/]/i.test(c) || /[\\/]claude(\.js|\.mjs|\.cmd)?["']?(\s|$)/i.test(c);
}

// procs: [{ pid, ppid, name, cmd }]. Returns the nearest Claude ancestor of startPid, or null.
export function findSession(procs, startPid) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  let pid = byPid.get(startPid)?.ppid;
  for (let i = 0; i < 40 && pid; i++) {
    const p = byPid.get(pid);
    if (!p || p.pid === startPid) return null;
    if (isClaude(p)) return p;
    pid = p.ppid;
  }
  return null;
}

// Parses `ps -A -o pid= -o ppid= -o args=` output.
export function parsePs(text) {
  const procs = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const cmd = m[3].trim();
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), name: cmd.split(/\s+/)[0], cmd });
  }
  return procs;
}

export function listProcesses(platform = process.platform) {
  if (platform === "win32") {
    const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true, maxBuffer: 64 << 20 });
    if (r.status !== 0) throw new Error(`process list failed: ${r.stderr || r.error?.message}`);
    const rows = JSON.parse(r.stdout || "[]");
    return (Array.isArray(rows) ? rows : [rows]).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, cmd: p.CommandLine || "" }));
  }
  const r = spawnSync("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "args="], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`process list failed: ${r.stderr || r.error?.message}`);
  return parsePs(r.stdout);
}

function end(pid) {
  // On Windows this is TerminateProcess; elsewhere SIGTERM lets Claude Code restore the terminal.
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
}

function main(argv) {
  const at = argv.indexOf("--end");
  if (at >= 0) {
    // The detached helper: wait, check the pid is still a Claude process, then end it.
    const pid = Number(argv[at + 1]);
    const delay = Number(argv[at + 2] || 3);
    setTimeout(() => {
      const p = listProcesses().find((q) => q.pid === pid);
      if (p && isClaude(p)) end(pid);
    }, delay * 1000);
    return;
  }
  const session = findSession(listProcesses(), process.pid);
  if (!session) {
    console.log("Couldn't find this session's Claude process. Nothing was closed. Type /exit to close it.");
    process.exitCode = 2;
    return;
  }
  if (argv.includes("--dry-run")) {
    console.log(`would close: pid ${session.pid} (${base(session.name)})`);
    return;
  }
  const self = fileURLToPath(import.meta.url);
  spawn(process.execPath, [self, "--end", String(session.pid), "3"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  console.log(`closing this session (pid ${session.pid}) in 3 seconds`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
