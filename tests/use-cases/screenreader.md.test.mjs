// Use case: tests/use-cases/screenreader.md
// Runs on any OS with no NVDA: the machine is faked through gatherFacts' probes, and verify talks to
// a stand-in MCP server written in Node.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pluginDir, skillFile, skillModule } from "../../scripts/layout.mjs";

// Nothing here touches the real state folder, NVDA settings or Claude Code registration.
process.env.SCREENREADER_HOME = mkdtempSync(path.join(tmpdir(), "screenreader-home-"));
process.env.NVDA_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "screenreader-nvda-"));
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "screenreader-claude-"));
const m = await skillModule("screenreader", "scripts/screenreader.mjs");
const SCRIPT = skillFile("screenreader", "scripts", "screenreader.mjs");
const SKILL = readFileSync(skillFile("screenreader", "SKILL.md"), "utf8");
const AGENT = readFileSync(path.join(pluginDir("power-tools-ui"), "agents", "screenreader-persona.md"), "utf8");
const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("NVDA versions compare by number, and the add-on needs 2026.3", () => {
  assert.equal(m.MIN_NVDA, "2026.3");
  assert.ok(m.versionAtLeast("2026.3.1.58288", "2026.3"));
  assert.ok(m.versionAtLeast("2026.3", "2026.3"));
  assert.ok(m.versionAtLeast("2027.1", "2026.3"));
  assert.ok(m.versionAtLeast("2026.10", "2026.3"), "10 is more than 3, not less");
  assert.ok(!m.versionAtLeast("2026.2.1", "2026.3"));
  assert.ok(!m.versionAtLeast(null, "2026.3"));
  assert.ok(!m.versionAtLeast("", "2026.3"));
});

test("NV Access's update answer gives the version, the launcher and its SHA-1", () => {
  const info = m.parseUpdateInfo("version: 2026.3.1\nlauncherUrl: https://download.nvaccess.org/releases/2026.3.1/nvda_2026.3.1.exe\nlauncherHash: ABCDEF0123\napiVersion: 2026.3.0\n");
  assert.deepEqual(info, { version: "2026.3.1", url: "https://download.nvaccess.org/releases/2026.3.1/nvda_2026.3.1.exe", sha1: "abcdef0123" });
  assert.throws(() => m.parseUpdateInfo(""), /no version/);
});

test("the add-on's settings come from nvda.ini's [nvdaMcp] section, with the add-on's defaults", () => {
  assert.deepEqual(m.addonSettings(""), { enabled: true, allowControl: false, confirmControl: true, allowedApps: [] });
  const ini = "schemaVersion = 19\r\n[speech]\r\n\tsynth = oneCore\r\n[nvdaMcp]\r\nallowControl = True\r\nallowedApps = \"brave,chrome\"\r\n\t[[sub]]\r\n\tallowControl = False\r\n[other]\r\nallowControl = False\r\n";
  assert.deepEqual(m.addonSettings(ini), { enabled: true, allowControl: true, confirmControl: true, allowedApps: ["brave", "chrome"] });
  assert.deepEqual(m.iniSection(ini, "speech"), { synth: "oneCore" }, "NVDA indents a section's keys");
});

test("allow-keys edits only [nvdaMcp], keeps the rest and the line endings, and quotes lists", () => {
  const ini = "schemaVersion = 19\r\n[nvdaMcp]\r\nallowControl = False\r\nlogActions = True\r\n\r\n[speech]\r\nsynth = oneCore\r\n";
  const out = m.setIniValues(ini, "nvdaMcp", { enabled: true, allowControl: true, allowedApps: "brave,chrome" });
  assert.equal(out, "schemaVersion = 19\r\n[nvdaMcp]\r\nallowControl = True\r\nlogActions = True\r\nenabled = True\r\nallowedApps = \"brave,chrome\"\r\n\r\n[speech]\r\nsynth = oneCore\r\n");
  assert.ok(!out.replace(/\r\n/g, "").includes("\n"), "no bare LF lines in a CRLF file");
  assert.deepEqual(m.addonSettings(out).allowedApps, ["brave", "chrome"]);

  // No section yet: it is added at the end. An empty list is written as "".
  const added = m.setIniValues("schemaVersion = 19\n", "nvdaMcp", { allowControl: true, allowedApps: "" });
  assert.equal(added, "schemaVersion = 19\n[nvdaMcp]\nallowControl = True\nallowedApps = \"\"\n");
  assert.deepEqual(m.addonSettings(added), { enabled: true, allowControl: true, confirmControl: true, allowedApps: [] });
  assert.equal(m.setIniValues("", "nvdaMcp", { allowControl: false }), "[nvdaMcp]\nallowControl = False\n");

  // New keys copy the section's indent (NVDA indents with a tab).
  assert.equal(m.setIniValues("[nvdaMcp]\n\tlogActions = True\n[x]\n", "nvdaMcp", { allowControl: true }), "[nvdaMcp]\n\tlogActions = True\n\tallowControl = True\n[x]\n");

  // A subsection ends the section's own keys: new keys go before it.
  const sub = m.setIniValues("[nvdaMcp]\nlogActions = True\n\t[[x]]\n\tk = 1\n", "nvdaMcp", { allowControl: true });
  assert.equal(sub, "[nvdaMcp]\nlogActions = True\nallowControl = True\n\t[[x]]\n\tk = 1\n");
});

test("app names for allow-keys are NVDA's: lower case, no .exe, nothing else", () => {
  assert.deepEqual(m.parseApps("Brave.exe, chrome ,"), ["brave", "chrome"]);
  assert.deepEqual(m.parseApps(""), []);
  assert.throws(() => m.parseApps("brave;calc"), /not an application name/);
  assert.equal(m.browserApp("BraveHTML"), "brave");
  assert.equal(m.browserApp("ChromeHTML"), "chrome");
  assert.equal(m.browserApp("MSEdgeHTM"), "msedge");
  assert.equal(m.browserApp("FirefoxURL-308046B0AF4A39CB"), "firefox");
  assert.equal(m.browserApp("SomethingElse"), null);
  assert.equal(m.browserApp(null), null);
});

test("the nvda server is found in user, local or project scope, and its pin is read", () => {
  const server = { type: "stdio", command: "uvx", args: ["nvda-mcp==1.1.0"], env: {} };
  const cwd = mkdtempSync(path.join(tmpdir(), "screenreader-cwd-"));
  assert.equal(m.mcpRegistration({ mcpServers: { nvda: server } }, cwd, null).scope, "user");
  assert.equal(m.mcpRegistration({ projects: { [cwd]: { mcpServers: { nvda: server } } } }, cwd, null).scope, "local");
  assert.equal(m.mcpRegistration({}, cwd, { mcpServers: { nvda: server } }).scope, "project");
  assert.equal(m.mcpRegistration({}, cwd, null), null);
  assert.equal(m.pinnedVersion(m.mcpRegistration({ mcpServers: { nvda: server } }, cwd, null)), "1.1.0");
  assert.equal(m.pinnedVersion({ command: "nvda-mcp", args: [] }), null);
});

// A Windows machine with everything set up; each test takes one thing away.
const ready = () => ({
  supported: true, reader: "nvda",
  nvda: { installed: true, recent: true, running: true, version: "2026.3.1" },
  addon: { installed: true, version: "1.1.0", pending: false, enabled: true, allowControl: true, confirmControl: true, allowedApps: ["brave"] },
  uv: true, mcp: { scope: "user", type: "stdio", command: "uvx", args: ["nvda-mcp==1.1.0"] }, browser: "brave", jaws: { installed: false },
});
const tweak = (fn) => { const f = ready(); fn(f); return m.planNext(f); };

test("setup goes one step at a time, in order, until only verify is left", () => {
  assert.equal(m.planNext(ready()), "verify");
  assert.equal(m.planNext({ supported: false }), "unsupported");
  assert.equal(tweak((f) => { f.reader = "jaws"; }), "jaws");
  assert.equal(tweak((f) => { f.nvda.installed = false; f.addon.installed = false; f.mcp = null; }), "install-nvda");
  assert.equal(tweak((f) => { f.nvda.recent = false; }), "update-nvda");
  assert.equal(tweak((f) => { f.addon.installed = false; }), "install-addon");
  assert.equal(tweak((f) => { f.addon.installed = false; f.addon.pending = true; }), "restart-nvda", "an install waiting for a restart");
  assert.equal(tweak((f) => { f.mcp = null; }), "register");
  assert.equal(tweak((f) => { f.mcp = null; f.uv = false; }), "install-uv");
  assert.equal(tweak((f) => { f.uv = false; }), "verify", "uv only matters while the server isn't registered");
  assert.equal(tweak((f) => { f.addon.allowControl = false; }), "allow-keys");
  assert.equal(tweak((f) => { f.addon.enabled = false; }), "allow-keys");
  assert.equal(tweak((f) => { f.nvda.running = false; }), "start-nvda");
});

test("detect warns about JAWS, a server pinned to another version, and keys allowed everywhere", () => {
  assert.deepEqual(m.warnings(ready()), []);
  const f = ready();
  f.jaws.installed = true;
  f.mcp.args = ["nvda-mcp==1.0.0"];
  f.addon.allowedApps = [];
  const w = m.warnings(f).join("\n");
  assert.match(w, /JAWS is installed too/);
  assert.match(w, /pinned to 1\.0\.0 but the add-on is 1\.1\.0.*register --replace/);
  assert.match(w, /every application.*allow-keys --apps brave/);
  const unpinned = ready();
  unpinned.mcp = { scope: "user", type: "stdio", command: "nvda-mcp", args: [] };
  assert.match(m.warnings(unpinned).join("\n"), /isn't pinned/);
  assert.deepEqual(m.warnings({ supported: false }), []);
});

test("detect reads the add-on, its settings and the registration from disk", () => {
  const cfg = process.env.NVDA_CONFIG_DIR;
  mkdirSync(path.join(cfg, "addons", "nvdaMcp"), { recursive: true });
  writeFileSync(path.join(cfg, "addons", "nvdaMcp", "manifest.ini"), 'name = nvdaMcp\r\nversion = "1.1.0"\r\nminimumNVDAVersion = 2026.3\r\n');
  writeFileSync(path.join(cfg, "nvda.ini"), "[nvdaMcp]\r\nallowControl = True\r\nallowedApps = brave\r\n");
  writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"), JSON.stringify({ mcpServers: { nvda: { type: "stdio", command: "uvx", args: ["nvda-mcp==1.1.0"], env: {} } } }));
  const reg = (key, name) => ({ InstallDir: "C:\\Program Files\\NVDA", DisplayVersion: "2026.3.1.58288", ProgId: "BraveHTML" })[name] ?? null;
  const cwd = mkdtempSync(path.join(tmpdir(), "screenreader-cwd-"));
  const machine = { platform: "win32", cwd, reg, running: () => true, has: () => true, exists: (p) => p.endsWith("nvda.exe") || existsSync(p) };
  const f = m.gatherFacts(machine);
  assert.deepEqual(f.nvda, { installed: true, dir: "C:/Program Files/NVDA", version: "2026.3.1.58288", recent: true, running: true });
  assert.equal(f.addon.version, "1.1.0");
  assert.equal(f.addon.allowControl, true);
  assert.deepEqual(f.addon.allowedApps, ["brave"]);
  assert.equal(f.addon.pending, false);
  assert.equal(f.mcp.scope, "user");
  assert.equal(f.browser, "brave");
  assert.equal(m.planNext(f), "verify");

  assert.equal(m.planNext(m.gatherFacts({ ...machine, reg: () => null })), "install-nvda");
  assert.equal(m.planNext(m.gatherFacts({ ...machine, running: () => false })), "start-nvda");
  assert.deepEqual(m.gatherFacts({ platform: "linux" }), { platform: "linux", supported: false, reader: null });
});

test("programs are started without cmd.exe where possible, and found on PATH by the script", () => {
  const env = { PATH: "C:\\bin;C:\\tools", PATHEXT: ".EXE;.CMD", USERPROFILE: "C:\\Profiles\\lee" };
  const at = (files) => ({ platform: "win32", env, exists: (f) => files.includes(f) });
  assert.deepEqual(m.resolveCommand("nvda-mcp", [], at(["C:\\tools\\nvda-mcp.exe"])), { file: "C:\\tools\\nvda-mcp.exe", args: [], shell: false });
  assert.deepEqual(m.resolveCommand("uvx", ["nvda-mcp==1.1.0"], at(["C:\\bin\\uvx.cmd"])), { file: '"C:\\bin\\uvx.cmd" "nvda-mcp==1.1.0"', args: [], shell: true });
  // uv's own folder counts even when this process's PATH predates the install.
  assert.equal(m.resolveCommand("uvx", [], at(["C:\\Profiles\\lee\\.local\\bin\\uvx.exe"])).file, "C:\\Profiles\\lee\\.local\\bin\\uvx.exe");
  assert.deepEqual(m.resolveCommand("C:\\py\\nvda-mcp.exe", ["--x"], at(["C:\\py\\nvda-mcp.exe"])), { file: "C:\\py\\nvda-mcp.exe", args: ["--x"], shell: false });
  assert.throws(() => m.resolveCommand("nope", [], at([])), /isn't on PATH/);
  assert.throws(() => m.resolveCommand("uvx", ["%PATH%"], at(["C:\\bin\\uvx.cmd"])), /cmd\.exe/);
  assert.deepEqual(m.resolveCommand("uvx", ["a"], { platform: "linux" }), { file: "uvx", args: ["a"], shell: false });
});

test("NVDA and its installer start the way Explorer starts them, with fixed flags only", () => {
  // Installed NVDA is a uiAccess program, so a direct spawn fails; `start` goes through ShellExecute.
  assert.equal(m.shellStartLine("C:\\Program Files\\NVDA\\nvda.exe", ["-r"]), '"start "" "C:\\Program Files\\NVDA\\nvda.exe" -r"');
  assert.equal(m.shellStartLine("D:\\dl\\nvda_2026.3.1.exe", ["--install-silent"], { wait: true }), '"start "" /wait "D:\\dl\\nvda_2026.3.1.exe" --install-silent"');
  assert.throws(() => m.shellStartLine("C:\\a\"b.exe"), /cmd\.exe/);
  assert.throws(() => m.shellStartLine("C:\\%TEMP%\\x.exe"), /cmd\.exe/);
  assert.throws(() => m.shellStartLine("C:\\nvda.exe", ["-r & calc"]), /cmd\.exe/);
});

test("only http and https pages can be opened", () => {
  assert.deepEqual(m.openCommand("https://shop.example.com/a?b=1", "win32"), { cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", "https://shop.example.com/a?b=1"] });
  assert.equal(m.openCommand("http://localhost:3000", "linux").cmd, "xdg-open");
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "https://a.example/\"&calc", "shop.example.com", "", undefined]) {
    assert.throws(() => m.openCommand(bad, "win32"), /http/, String(bad));
  }
});

test("the report goes to docs/accessibility in a repo, otherwise to the state folder", () => {
  const now = Date.UTC(2026, 10, 10, 12);
  const inRepo = m.reportPaths({ cwd: "/work/shop", slug: "Shop: newsletter sign-up!", now, isRepo: true });
  assert.equal(inRepo.report, "/work/shop/docs/accessibility/2026-11-10-shop-newsletter-sign-up-screenreader.md");
  assert.equal(inRepo.transcript, "/work/shop/docs/accessibility/2026-11-10-shop-newsletter-sign-up-screenreader-transcript.md");
  const outside = m.reportPaths({ cwd: "/work/none", slug: "", now, isRepo: false });
  assert.ok(outside.report.endsWith("/reports/2026-11-10-page-screenreader.md"), outside.report);
  assert.ok(outside.report.startsWith(process.env.SCREENREADER_HOME.replaceAll("\\", "/")));
  assert.ok(m.reportPaths({ cwd: "/w", slug: "x".repeat(200), now, isRepo: true }).report.length < 120);
});

// A stand-in for nvda-mcp: answers the MCP handshake, tools/list and nvda_get_status.
const FAKE = path.join(mkdtempSync(path.join(tmpdir(), "screenreader-fake-")), "fake-nvda-mcp.mjs");
writeFileSync(FAKE, `
const mode = process.env.FAKE_MODE || "ok";
if (mode === "crash") { console.error("boom: no NVDA here"); process.exit(3); }
const tools = ${JSON.stringify(m.PERSONA_TOOLS)}.concat(["nvda_capture_control"]).filter((t) => mode !== "old" || t !== "nvda_list_elements");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (msg.id === undefined) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
    if (msg.method === "initialize") reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "nvda_mcp", version: "test" } });
    else if (msg.method === "tools/list") reply({ tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) });
    else if (msg.method === "tools/call" && mode === "nonvda") reply({ isError: true, content: [{ type: "text", text: "Error executing tool nvda_get_status: NVDA is not reachable: connection.json does not exist." }] });
    else if (msg.method === "tools/call") reply({ content: [{ type: "text", text: JSON.stringify({ nvdaVersion: "2026.3.1", addonVersion: "1.1.0", isControlAllowed: mode !== "locked", lastSpeechId: 41 }) }] });
  }
});
`);
const fake = (mode) => ({ scope: "user", type: "stdio", command: process.execPath, args: [FAKE], env: { FAKE_MODE: mode } });

test("verify starts the registered server, lists its tools and asks NVDA for its status", async () => {
  const ok = await m.verify({ registration: fake("ok"), startupMs: 20_000 });
  assert.equal(ok.ok, true, ok.problems.join("; "));
  assert.equal(ok.server.name, "nvda_mcp");
  assert.deepEqual(ok.missing, []);
  assert.equal(ok.status.lastSpeechId, 41);

  const old = await m.verify({ registration: fake("old"), startupMs: 20_000 });
  assert.equal(old.ok, false);
  assert.deepEqual(old.missing, ["nvda_list_elements"]);

  const locked = await m.verify({ registration: fake("locked"), startupMs: 20_000 });
  assert.match(locked.problems.join(), /doesn't let MCP clients press keys: run allow-keys/);

  const nonvda = await m.verify({ registration: fake("nonvda"), startupMs: 20_000 });
  assert.match(nonvda.problems.join(), /^NVDA is not reachable/);

  const crash = await m.verify({ registration: fake("crash"), startupMs: 20_000 });
  assert.match(crash.problems.join(), /didn't answer: the server exited with code 3: boom: no NVDA here/);

  assert.match((await m.verify({ registration: null })).problems.join(), /isn't registered.*run register/);
  assert.match((await m.verify({ registration: { type: "http", url: "http://x" } })).problems.join(), /stdio servers only/);
});

test("the CLI chooses a screen reader, explains JAWS, prints paths and rejects unknown commands", () => {
  assert.match(run(["--self-test"]).stdout, /^ok\b/);
  const jaws = run(["choose", "jaws"]);
  assert.equal(jaws.status, 0);
  assert.match(jaws.stdout, /No MCP server can drive JAWS yet.*choose nvda/s);
  assert.equal(JSON.parse(readFileSync(path.join(process.env.SCREENREADER_HOME, "state.json"), "utf8")).reader, "jaws");
  assert.match(run(["choose", "nvda"]).stdout, /NVDA/);
  assert.equal(run(["choose", "voiceover"]).status, 1);
  assert.equal(run(["bogus"]).status, 2);
  const paths = JSON.parse(run(["paths", "--slug", "shop newsletter"]).stdout);
  assert.match(paths.report, /\d{4}-\d\d-\d\d-shop-newsletter-screenreader\.md$/);
  assert.equal(JSON.parse(run(["open", "https://shop.example.com", "--dry-run"]).stdout).dryRun, true);
  assert.equal(run(["open", "file:///etc/passwd", "--dry-run"]).status, 1);
  assert.match(run(["allow-keys"]).stderr, /--apps/);
  const detect = JSON.parse(run(["detect"]).stdout);
  assert.ok(["unsupported", "jaws", "install-nvda", "update-nvda", "restart-nvda", "install-addon", "install-uv", "register", "allow-keys", "start-nvda", "verify"].includes(detect.next), detect.next);
});

test("the persona can only press keys and listen: no tool shows it the page", () => {
  const tools = /^tools:\s*(.+)$/m.exec(AGENT)[1].split(",").map((t) => t.trim());
  assert.deepEqual(tools, ["ToolSearch", ...m.PERSONA_TOOLS.map((t) => `mcp__nvda__${t}`)]);
  assert.deepEqual(m.PERSONA_TOOLS.filter((t) => m.SIGHTED_TOOLS.includes(t)), []);
  for (const banned of ["Read", "Bash", "WebFetch", "mcp__claude-in-chrome", "capture_control", "inspect_html", "object_tree"]) {
    assert.ok(!tools.some((t) => t.includes(banned)), banned);
  }
  assert.match(AGENT, /^name: screenreader-persona$/m);
  assert.match(AGENT, /Never pass `record` or `record_within`/);
  assert.match(AGENT, /Stop before anything you can't undo/);
  assert.match(AGENT, /test@example\.com/);
  assert.match(AGENT, /controlDenied.*stop at once/s);
  // The ToolSearch line loads exactly the persona's tools.
  const select = /`select:([^`]+)`/.exec(AGENT)[1].split(",");
  assert.deepEqual(select, m.PERSONA_TOOLS.map((t) => `mcp__nvda__${t}`));
});

test("the skill handles every setup step the script can print, and only calls real commands", () => {
  for (const step of ["unsupported", "jaws", "install-nvda", "update-nvda", "install-addon", "restart-nvda", "install-uv", "register", "allow-keys", "start-nvda", "verify"]) {
    assert.match(SKILL, new RegExp(`^\\|[^\\n|]*\`${step}\``, "m"), `SKILL.md has no row for ${step}`);
  }
  const commands = new Set([...readFileSync(SCRIPT, "utf8").matchAll(/^\s*case "([\w-]+)"/gm)].map((x) => x[1]));
  for (const [, cmd] of SKILL.matchAll(/`SR ([\w-]+)/g)) assert.ok(commands.has(cmd), `SKILL.md runs SR ${cmd}, which the script doesn't have`);
  // The one rule, the consent questions, and the way back.
  assert.match(SKILL, /nobody looks at the page/);
  for (const never of ["screenshots", "WebFetch", "nvda_capture_control", "nvda_inspect_html"]) assert.ok(SKILL.includes(never), never);
  assert.match(SKILL, /Only in my browser \(Recommended\)/);
  assert.match(SKILL, /Install NVDA now \(Recommended\)/);
  assert.match(SKILL, /keys-off/);
  assert.match(SKILL, /reconnect \*\*nvda\*\*/);
  assert.match(SKILL, /power-tools-ui:screenreader-persona/);
  assert.match(SKILL, /Never commit the report/);
  assert.ok(!/\bblind\b/i.test(SKILL + AGENT), "say vision impaired");
});

test("a plain request picks the skill in the trigger eval", () => {
  const dir = path.join(pluginDir("power-tools-ui"), "evals", "triggers", "screenreader");
  assert.match(readFileSync(path.join(dir, "prompt.md"), "utf8"), /NVDA/);
  assert.match(readFileSync(path.join(dir, "graders", "skill-fired.md"), "utf8"), /screenreader"'/);
  execFileSync(process.execPath, ["--check", SCRIPT]);
});
