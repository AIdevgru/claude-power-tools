// Use case: tests/use-cases/all.md
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { skillFile } from "../../scripts/layout.mjs";

const SKILL = readFileSync(skillFile("all", "SKILL.md"), "utf8");
const { findSession, isClaude, listProcesses, parsePs } = await import(pathToFileURL(skillFile("all", "scripts", "quit.mjs")).href);
const AT = skillFile("all", "scripts", "at.mjs");
const { cronFor, nextRun, parseClock } = await import(pathToFileURL(AT).href);

test("/all sends to every ListAgents row word for word, then closes only through quit.mjs", () => {
  assert.match(SKILL, /^disable-model-invocation: true$/m, "only the owner can start a skill that closes the session");
  assert.match(SKILL, /^allowed-tools: ListAgents, SendMessage, ToolSearch, Bash, CronCreate$/m);
  assert.match(SKILL, /\*\*every row\*\*/);
  assert.match(SKILL, /\*\*word for word\*\*/);
  assert.match(SKILL, /Skip only this session's own row/);
  assert.match(SKILL, /scripts\/quit\.mjs/);
  assert.match(SKILL, /it's empty, reply `Usage: \/all \[--at <time>\] "<message>"` and stop\. \*\*Don't close the session\.\*\*/);
  assert.match(SKILL, /no message was delivered .* \*\*don't close\*\*/);
  assert.match(SKILL, /exits with code 2.*type `\/exit`/);
});

test("/all --at schedules one run in this session that carries the steps, and sends or closes nothing now", () => {
  assert.match(SKILL, /^argument-hint: "\[--at <time>\] \\"<message>\\""$/m);
  const step = /## Step 2: schedule it \(only with `--at`\)\n([\s\S]*?)\n## Step 3/.exec(SKILL)?.[1];
  assert.ok(step, "Step 2 schedules");
  assert.match(SKILL, /`AT` means `node "<this skill's base directory>\/scripts\/at\.mjs"`/);
  assert.match(step, /Run `AT <time>` with Bash/, "the time is read by the script, not guessed");
  assert.match(step, /exits 1, print its line and stop\. \*\*Don't close the session\.\*\*/);
  assert.match(step, /`recurring: false`/, "it runs once, then the job is gone");
  assert.match(step, /the owner typed `\/all --at <time>` in this session/, "the scheduled run says whose it is");
  assert.match(step, /do its Steps 3 to 5 now/, "a scheduled prompt can't start the skill, so it carries the steps");
  assert.match(step, /message on the last line \*\*word for word\*\*/);
  assert.match(step, /Send nothing now, and \*\*don't close the session\*\*/);
  assert.match(step, /job ID|delete job/);
  assert.match(SKILL, /## Step 3: send it[\s\S]*## Step 4: report[\s\S]*## Step 5: close this session/, "Steps 3 to 5 are send, report, close");
});

test("at.mjs reads 12- and 24-hour clock times and refuses anything else", () => {
  assert.deepEqual(parseClock("5:30"), { hour: 5, minute: 30 });
  assert.deepEqual(parseClock("05:30"), { hour: 5, minute: 30 });
  assert.deepEqual(parseClock("17:30"), { hour: 17, minute: 30 });
  assert.deepEqual(parseClock("5:30am"), { hour: 5, minute: 30 });
  assert.deepEqual(parseClock("5:30 PM"), { hour: 17, minute: 30 });
  assert.deepEqual(parseClock("7pm"), { hour: 19, minute: 0 });
  assert.deepEqual(parseClock("7"), { hour: 7, minute: 0 });
  assert.deepEqual(parseClock("12am"), { hour: 0, minute: 0 });
  assert.deepEqual(parseClock("12pm"), { hour: 12, minute: 0 });
  for (const bad of ["", "soon", "25:00", "9:75", "13pm", "0am", "5:3", "tomorrow 5:30"]) assert.equal(parseClock(bad), null, bad);
});

test("at.mjs picks the next time the clock shows it, and pins the day so the job matches once", () => {
  const at = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s);
  assert.equal(cronFor(nextRun({ hour: 5, minute: 30 }, at(2026, 11, 9, 3, 50))), "30 5 9 11 *", "later today");
  assert.equal(cronFor(nextRun({ hour: 5, minute: 30 }, at(2026, 11, 9, 14, 40))), "30 5 10 11 *", "passed today: tomorrow");
  assert.equal(cronFor(nextRun({ hour: 5, minute: 30 }, at(2026, 11, 9, 5, 30, 20))), "30 5 10 11 *", "this minute already started: tomorrow");
  assert.equal(cronFor(nextRun({ hour: 5, minute: 30 }, at(2026, 12, 31, 23, 0))), "30 5 1 1 *", "over the year end");
  assert.equal(cronFor(nextRun({ hour: 0, minute: 5 }, at(2026, 2, 28, 12, 0))), "5 0 1 3 *", "over a month end");
});

test("at.mjs prints the cron and the time when run, and exits 1 on a time it can't read", () => {
  const ok = spawnSync(process.execPath, [AT, "5:30", "pm"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^cron: 30 17 \d{1,2} \d{1,2} \*\nwhen: \w{3}, \w{3} \d{1,2}, 5:30 PM/);
  const bad = spawnSync(process.execPath, [AT, "soon"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^Couldn't read the time "soon"\./);
});

test("isClaude knows claude and node-run claude, and never a shell", () => {
  assert.ok(isClaude({ name: "claude.exe", cmd: '"C:\\Users\\a\\.local\\bin\\claude.exe"' }));
  assert.ok(isClaude({ name: "claude", cmd: "claude --resume" }));
  assert.ok(isClaude({ name: "node", cmd: "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js" }));
  assert.ok(isClaude({ name: "node", cmd: "node /usr/local/bin/claude" }));
  assert.ok(!isClaude({ name: "bash.exe", cmd: 'bash -c "source /c/Users/a/.claude/x.sh && node quit.mjs"' }));
  assert.ok(!isClaude({ name: "pwsh", cmd: "pwsh -c claude" }));
  assert.ok(!isClaude({ name: "node", cmd: "node C:\\Users\\a\\.claude\\skills\\all\\scripts\\quit.mjs" }));
  assert.ok(!isClaude({ name: "Code.exe", cmd: "Code.exe --folder-uri file:///c/claude" }));
});

test("findSession returns this session's nearest Claude ancestor, not another session's", () => {
  const procs = [
    { pid: 1, ppid: 0, name: "init", cmd: "init" },
    { pid: 10, ppid: 1, name: "claude", cmd: "claude" }, // this session
    { pid: 11, ppid: 10, name: "bash", cmd: "bash -c 'node quit.mjs'" },
    { pid: 12, ppid: 11, name: "node", cmd: "node quit.mjs" }, // the script
    { pid: 20, ppid: 1, name: "claude", cmd: "claude" }, // another session
    { pid: 21, ppid: 20, name: "bash", cmd: "bash" },
  ];
  assert.equal(findSession(procs, 12)?.pid, 10);
  assert.equal(findSession(procs, 21)?.pid, 20);
  assert.equal(findSession(procs.filter((p) => p.pid !== 10), 12), null, "no Claude ancestor: close nothing");
  const loop = [{ pid: 5, ppid: 6, name: "node", cmd: "node x" }, { pid: 6, ppid: 5, name: "bash", cmd: "bash" }];
  assert.equal(findSession(loop, 5), null, "a parent loop ends the walk");
});

test("parsePs reads ps output, and listProcesses sees this test's own process", () => {
  assert.deepEqual(parsePs("  10     1 /usr/local/bin/claude --resume\n  11    10 bash\n"), [
    { pid: 10, ppid: 1, name: "/usr/local/bin/claude", cmd: "/usr/local/bin/claude --resume" },
    { pid: 11, ppid: 10, name: "bash", cmd: "bash" },
  ]);
  const me = listProcesses().find((p) => p.pid === process.pid);
  assert.ok(me, "this process is listed");
  assert.equal(me.ppid, process.ppid);
});

test("quit.mjs runs when started through a linked install (a junction or symlink)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cpt-all-"));
  try {
    const link = path.join(dir, "all");
    symlinkSync(path.dirname(skillFile("all", "SKILL.md")), link, "junction");
    const r = spawnSync(process.execPath, [path.join(link, "scripts", "quit.mjs"), "--dry-run"], { encoding: "utf8" });
    // Inside a Claude session it names the process it would close; outside one it says it found none.
    assert.match(r.stdout, /^(would close: pid \d+|Couldn't find this session's Claude process)/, `no output: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
