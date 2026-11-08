// Use case: tests/use-cases/all.md
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { skillFile } from "../../scripts/layout.mjs";

const SKILL = readFileSync(skillFile("all", "SKILL.md"), "utf8");
const { findSession, isClaude, listProcesses, parsePs } = await import(pathToFileURL(skillFile("all", "scripts", "quit.mjs")).href);

test("/all sends to every ListAgents row word for word, then closes only through quit.mjs", () => {
  assert.match(SKILL, /^disable-model-invocation: true$/m, "only the owner can start a skill that closes the session");
  assert.match(SKILL, /^allowed-tools: ListAgents, SendMessage, ToolSearch, Bash$/m);
  assert.match(SKILL, /\*\*every row\*\*/);
  assert.match(SKILL, /\*\*word for word\*\*/);
  assert.match(SKILL, /Skip only this session's own row/);
  assert.match(SKILL, /scripts\/quit\.mjs/);
  assert.match(SKILL, /it's empty, reply `Usage: \/all "<message>"` and stop\. \*\*Don't close the session\.\*\*/);
  assert.match(SKILL, /no message was delivered .* \*\*don't close\*\*/);
  assert.match(SKILL, /exits with code 2.*type `\/exit`/);
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
