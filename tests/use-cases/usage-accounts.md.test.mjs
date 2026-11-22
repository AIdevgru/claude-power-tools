// Use case: tests/use-cases/usage-accounts.md
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { skillFile, skillModule } from "../../scripts/layout.mjs";

// Nothing here reads the real login or writes the real state folder.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "usage-accounts-cfg-"));
process.env.USAGE_HANDOFF_HOME = mkdtempSync(path.join(tmpdir(), "usage-accounts-"));
delete process.env.USAGE_HANDOFF_FIXTURE;
delete process.env.USAGE_HANDOFF_CMD;
const m = await skillModule("usage-handoff", "scripts/usage.mjs");
const SCRIPT = skillFile("usage-handoff", "scripts", "usage.mjs");

const T0 = Date.UTC(2026, 10, 1, 20, 0, 0);
const MIN = 60_000;
const H = 60 * MIN;
const ESC = "\x1b";
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const windows = (five, week, fiveReset = T0 + 30 * MIN, weekReset = T0 + 3 * 24 * H) => [
  { name: "five_hour", pct: five, resetsAt: fiveReset },
  { name: "seven_day", pct: week, resetsAt: weekReset },
];
const PERSONAL = { key: "u1/o1", email: "lee@example.com", name: "Lee", org: null, plan: "Max 5x" };
const WORK = { key: "u1/o2", email: "lee@acme.dev", name: "Lee", org: "Acme Robotics", plan: "Team" };

function freshHome() {
  const dir = mkdtempSync(path.join(tmpdir(), "usage-accounts-"));
  process.env.USAGE_HANDOFF_HOME = dir;
  return dir;
}

// What Claude Code saves at login: the account in .claude.json, the token in .credentials.json.
function saveLogin(dir, { account, token = "sk-ant-oat-secret", ageMs = H }) {
  writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ numStartups: 3, projects: {}, ...(account ? { oauthAccount: account } : {}) }));
  const cred = path.join(dir, ".credentials.json");
  writeFileSync(cred, JSON.stringify({ claudeAiOauth: { accessToken: token, subscriptionType: "max" } }));
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(cred, t, t);
}
const PERSONAL_SAVED = {
  accountUuid: "u1", organizationUuid: "o1", emailAddress: "lee@example.com", displayName: "Lee",
  organizationName: "lee@example.com's Organization", organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_5x",
};

test("the plan reads like Claude's own names", () => {
  assert.equal(m.planLabel({ type: "claude_max", tier: "default_claude_max_5x" }), "Max 5x");
  assert.equal(m.planLabel({ type: "claude_max", tier: "default_claude_max_20x" }), "Max 20x");
  assert.equal(m.planLabel({ type: "claude_max" }), "Max");
  assert.equal(m.planLabel({ type: "claude_pro" }), "Pro");
  assert.equal(m.planLabel({ type: "claude_team", tier: "default_claude_max_5x" }), "Team");
  assert.equal(m.planLabel({ type: "claude_enterprise" }), "Enterprise");
  assert.equal(m.planLabel({}), null);
});

test("who is logged in comes from Claude Code's .claude.json, never the token", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "usage-accounts-login-"));
  const env = { CLAUDE_CONFIG_DIR: dir };
  saveLogin(dir, { account: PERSONAL_SAVED });
  const me = m.currentAccount("stamp", Date.now(), env);
  assert.deepEqual(me, PERSONAL, "a personal organization's name is left out");
  assert.ok(!JSON.stringify(me).includes("sk-ant"));

  // A Team seat is its own account, and names its organization.
  saveLogin(dir, { account: { accountUuid: "u1", organizationUuid: "o2", emailAddress: "lee@acme.dev", displayName: "Lee", organizationName: "Acme Robotics", organizationType: "claude_team" } });
  assert.deepEqual(m.currentAccount("stamp", Date.now(), env), WORK);

  // The token is saved a moment before the account: until then, nobody is filed.
  saveLogin(dir, { account: PERSONAL_SAVED, ageMs: 2000 });
  assert.equal(m.currentAccount("stamp", Date.now(), env), undefined);
  assert.deepEqual(m.currentAccount("stamp", Date.now() + 15_000, env), PERSONAL, "a few seconds later it is");

  // Logged out, a test fixture, or no account saved: nobody.
  saveLogin(dir, { account: PERSONAL_SAVED });
  assert.equal(m.currentAccount("none", Date.now(), env), null);
  assert.equal(m.currentAccount("stamp", Date.now(), { ...env, USAGE_HANDOFF_FIXTURE: "x.json" }), null);
  saveLogin(dir, { account: null });
  assert.equal(m.currentAccount("stamp", Date.now(), env), null);
});

test("each reading is filed under its account, once; switching logins keeps the other's numbers", async () => {
  const home = freshHome();
  let who = PERSONAL;
  let looks = 0;
  const identify = () => ((looks += 1), who);
  const reading = (w) => async () => ({ windows: w });

  await m.cachedWindows(T0, 95, reading(windows(97, 49)), false, "tok-a", identify);
  let book = m.readAccounts();
  assert.equal(book.current, "u1/o1");
  const p = book.accounts["u1/o1"];
  assert.deepEqual([p.email, p.plan, p.since, p.readAt], ["lee@example.com", "Max 5x", iso(T0), iso(T0)]);
  assert.deepEqual(p.windows, [
    { name: "five_hour", pct: 97, resetsAt: iso(T0 + 30 * MIN) },
    { name: "seven_day", pct: 49, resetsAt: iso(T0 + 3 * 24 * H) },
  ]);
  assert.ok(existsSync(path.join(home, "accounts.html")), "the page is written with the record");
  const cached = await m.cachedWindows(T0 + 20_000, 95, reading(windows(1, 1)), false, "tok-a", identify);
  assert.equal(cached.cached, true);
  assert.equal(cached.account.email, "lee@example.com");
  assert.equal(looks, 1, "a cached reading is filed once, not on every call");

  // Lee logs in to the work account: the new login reads at once and files there.
  who = WORK;
  const r = await m.cachedWindows(T0 + 2 * MIN, 95, reading(windows(12, 30, T0 + 4 * H, T0 + 5 * 24 * H)), false, "tok-b", identify);
  assert.deepEqual([r.cached, r.account.email], [false, "lee@acme.dev"]);
  book = m.readAccounts();
  assert.equal(book.current, "u1/o2");
  assert.equal(book.accounts["u1/o2"].since, iso(T0 + 2 * MIN));
  assert.equal(book.accounts["u1/o2"].org, "Acme Robotics");
  assert.equal(book.accounts["u1/o1"].windows[0].pct, 97, "the personal account keeps its last numbers");
  assert.equal(book.accounts["u1/o1"].lastSeen, iso(T0));

  // Back to the personal account later: its "logged in since" moves to now.
  who = PERSONAL;
  await m.cachedWindows(T0 + H, 95, reading(windows(3, 50, T0 + 6 * H)), false, "tok-a2", identify);
  book = m.readAccounts();
  assert.equal(book.current, "u1/o1");
  assert.deepEqual([book.accounts["u1/o1"].since, book.accounts["u1/o1"].windows[0].pct], [iso(T0 + H), 3]);
  assert.equal(Object.keys(book.accounts).length, 2);
  assert.deepEqual(readdirSync(home).filter((n) => n.endsWith(".tmp")), [], "no half-written files left behind");
});

test("a reading taken while a login is being saved waits, then is filed under the new account", async () => {
  const home = freshHome();
  let who; // undefined: the account isn't saved yet
  await m.cachedWindows(T0, 95, async () => ({ windows: windows(40, 10) }), false, "tok-b", () => who);
  assert.equal(m.readAccounts().current, null, "not filed under anyone yet");
  assert.equal(JSON.parse(readFileSync(path.join(home, "usage-cache.json"), "utf8")).account, undefined);

  who = WORK;
  const noRead = async () => { throw new Error("the status line has no reason to read"); };
  const cache = await m.statusCache({ now: T0 + MIN, login: "tok-b", identify: () => who, read: noRead });
  assert.equal(cache.account.email, "lee@acme.dev");
  assert.equal(m.readAccounts().accounts["u1/o2"].windows[0].pct, 40);
  assert.equal(JSON.parse(readFileSync(path.join(home, "usage-cache.json"), "utf8")).account.email, "lee@acme.dev");
  assert.match(m.statusText({ cache, now: T0 + MIN }), /^lee@acme\.dev · 5h 40%/);
});

test("a failed reading keeps the last good numbers; logging out leaves no account current", () => {
  freshHome();
  m.recordReading(PERSONAL, { at: T0, windows: windows(60, 40) }, T0);
  m.recordReading(PERSONAL, { at: T0 + 5 * MIN, error: "the saved login token has expired; any running Claude Code session renews it" }, T0 + 5 * MIN);
  let a = m.readAccounts().accounts["u1/o1"];
  assert.equal(a.windows[0].pct, 60);
  assert.deepEqual([a.error.slice(0, 22), a.errorAt], ["the saved login token ", iso(T0 + 5 * MIN)]);
  m.recordReading(PERSONAL, { at: T0 - MIN, windows: windows(10, 10) }, T0 + 6 * MIN);
  assert.equal(m.readAccounts().accounts["u1/o1"].windows[0].pct, 60, "an older reading filed late doesn't win");
  m.recordReading(PERSONAL, { at: T0 + 10 * MIN, windows: windows(61, 40) }, T0 + 10 * MIN);
  a = m.readAccounts().accounts["u1/o1"];
  assert.deepEqual([a.windows[0].pct, a.error], [61, undefined], "a good reading clears the error");

  m.recordReading(WORK, { at: T0 + 20 * MIN, windows: windows(5, 5) }, T0 + 20 * MIN);
  m.recordReading(null, { at: T0 + 30 * MIN, error: "not logged in with a Claude subscription (no OAuth token)" }, T0 + 30 * MIN);
  const book = m.readAccounts();
  assert.equal(book.current, null);
  assert.equal(Object.keys(book.accounts).length, 2, "logging out forgets nobody");
  const loggedOut = { at: T0 + 30 * MIN, error: "not logged in with a Claude subscription (no OAuth token)", account: null };
  assert.equal(m.statusText({ cache: loggedOut, book, now: T0 + 30 * MIN }), "usage: not logged in with a Claude subscription (no OAuth token) · 2 accounts");
});

test("the status line leads with the account, counts the others, and links to the page", () => {
  const cache = { at: T0, account: WORK, windows: [{ name: "five_hour", pct: 12.4, resetsAt: T0 + 30 * MIN }] };
  const soon = m.localTime(T0 + 30 * MIN, T0);
  const book = { current: "u1/o2", accounts: { "u1/o1": {}, "u1/o2": {} } };
  assert.equal(m.statusText({ cache, now: T0 }), `lee@acme.dev · 5h 12% (resets ${soon})`);
  assert.equal(m.statusText({ cache, book, now: T0 }), `lee@acme.dev (+1) · 5h 12% (resets ${soon})`);
  const url = "file:///home/lee/.claude/usage-handoff/accounts.html";
  assert.equal(m.statusText({ cache, book, now: T0, link: url }), `${ESC}]8;;${url}\x07lee@acme.dev (+1) · 5h 12% (resets ${soon})${ESC}]8;;\x07`);
  assert.equal(m.statusText({ cache: { ...cache, account: undefined }, now: T0 }), `5h 12% (resets ${soon})`, "a reading not filed yet reads as before");
});

test("the session's model follows the account, as Claude Code names it", () => {
  const cache = { at: T0, account: WORK, windows: [{ name: "five_hour", pct: 12.4, resetsAt: T0 + 30 * MIN }] };
  const soon = m.localTime(T0 + 30 * MIN, T0);
  const book = { current: "u1/o2", accounts: { "u1/o1": {}, "u1/o2": {} } };
  const input = (model) => JSON.stringify({ hook_event_name: "Status", session_id: "abc", model, workspace: { current_dir: "/repo" } });
  const opus = m.sessionModel(input({ id: "claude-opus-5-5", display_name: "Opus 5.5" }));
  assert.equal(opus, "Opus 5.5");
  assert.equal(m.statusText({ cache, book, now: T0, model: opus }), `lee@acme.dev (+1) · Opus 5.5 · 5h 12% (resets ${soon})`);
  // after /model sonnet, the next refresh names Sonnet
  assert.equal(m.statusText({ cache, now: T0, model: m.sessionModel(input({ id: "claude-sonnet-5-5", display_name: "Sonnet 5.5" })) }), `lee@acme.dev · Sonnet 5.5 · 5h 12% (resets ${soon})`);
  const loggedOut = { at: T0, error: "not logged in with a Claude subscription (no OAuth token)", account: null };
  assert.equal(m.statusText({ cache: loggedOut, book, now: T0, model: opus }), "Opus 5.5 · usage: not logged in with a Claude subscription (no OAuth token) · 2 accounts");

  assert.equal(m.sessionModel(input({ id: "claude-haiku-5-5" })), "claude-haiku-5-5", "no display name: the id");
  assert.equal(m.sessionModel(`﻿${input({ display_name: "Opus 5.5" })}`), "Opus 5.5", "a PowerShell pipe's byte order mark");
  for (const bad of ["", "not json", "null", "{}", input(null), input({ display_name: 5 })]) assert.equal(m.sessionModel(bad), null, bad);
  assert.equal(m.sessionModel(input({ display_name: `Opus${ESC}[2J${ESC}]8;;http://x\x07 5.5\n` })), "Opus 5.5", "escape codes and newlines dropped");
  assert.equal(m.sessionModel(input({ display_name: "x".repeat(60) })), `${"x".repeat(39)}…`);
});

test("/usage-handoff accounts lists every account, the logged-in one first and starred", () => {
  const book = {
    current: "u1/o2",
    accounts: {
      "u1/o1": { email: "lee@example.com", plan: "Max 5x", since: iso(T0 - 5 * H), lastSeen: iso(T0 - 2 * H), windows: [{ name: "five_hour", pct: 97, resetsAt: iso(T0 - H) }, { name: "seven_day", pct: 49, resetsAt: iso(T0 + 3 * 24 * H) }] },
      "u1/o2": { email: "lee@acme.dev", org: "Acme Robotics", plan: "Team", since: iso(T0 - 2 * H), lastSeen: iso(T0), windows: [{ name: "seven_day", pct: 30, resetsAt: iso(T0 + 5 * 24 * H) }, { name: "five_hour", pct: 12, resetsAt: iso(T0 + 4 * H) }] },
      "u9": { email: "side@example.org", lastSeen: iso(T0 - 30 * 24 * H), error: "usage endpoint answered HTTP 401" },
    },
  };
  const lines = m.accountsText(book, T0).split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], `* lee@acme.dev (Team, Acme Robotics) · 5h 12% (resets ${m.shortLocalTime(T0 + 4 * H, T0)}) · week 30% (resets ${m.shortLocalTime(T0 + 5 * 24 * H, T0)}) · logged in since ${m.shortLocalTime(T0 - 2 * H, T0)}`);
  assert.match(lines[1], new RegExp(`^  lee@example\\.com \\(Max 5x\\) · 5h reset ${reEsc(m.shortLocalTime(T0 - H, T0))} \\(was 97%\\) · week 49% \\(resets .+\\) · last used `));
  assert.match(lines[2], /^ {2}side@example\.org · no reading yet · last read failed: usage endpoint answered HTTP 401 · last used /);
  assert.match(m.accountsText({ current: null, accounts: {} }), /^No accounts recorded yet/);
});

test("the accounts page shows a meter, reset and countdown for each window, safely escaped", () => {
  const book = {
    current: "u1/o2",
    accounts: {
      "u1/o1": { email: "lee@example.com", plan: "Max 5x", lastSeen: iso(T0 - 2 * H), readAt: iso(T0 - 2 * H), windows: [{ name: "five_hour", pct: 97, resetsAt: iso(T0 - H) }, { name: "seven_day", pct: 85, resetsAt: iso(T0 + 2 * 24 * H) }] },
      "u1/o2": { email: "lee@acme.dev", org: "<script>alert(1)</script>", plan: "Team", since: iso(T0 - H), lastSeen: iso(T0), readAt: iso(T0 - 3 * MIN), windows: [{ name: "five_hour", pct: 40, resetsAt: iso(T0 + 2 * H + 12 * MIN) }, { name: "seven_day_opus", pct: 96, resetsAt: iso(T0 + 24 * H) }] },
    },
  };
  const html = m.accountsHtml(book, { now: T0, threshold: 95 });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta http-equiv="refresh" content="60">/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.ok(html.indexOf("lee@acme.dev") < html.indexOf("lee@example.com"), "the logged-in account comes first");
  assert.equal((html.match(/class="badge">Logged in</g) ?? []).length, 1);
  assert.ok(!html.includes("<script>alert(1)") && html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "names are escaped");
  // Each window: a meter with its value and level, its reset and a countdown.
  assert.match(html, /<li class="win ok" data-resets="2026-11-01T22:12:00Z">/);
  assert.match(html, /role="meter" aria-label="5-hour usage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="40"/);
  assert.match(html, /\(in 2 h 12 min\)/);
  assert.match(html, /<li class="win full"[^>]*>[\s\S]*?Weekly, Opus[\s\S]*?at the limit/);
  assert.match(html, /<li class="win near"[^>]*>[\s\S]*?Weekly<[\s\S]*?near the limit/);
  // A reset that has passed: an empty meter, and what it was.
  assert.match(html, /<li class="win full reset"/);
  assert.match(html, /\(was 97%\)/);
  assert.match(m.accountsHtml({ current: null, accounts: {} }), /No accounts yet/);

  assert.deepEqual([20_000, 5 * MIN, 2 * H, 2 * H + 12 * MIN, 3 * 24 * H + 8 * H].map(m.span), ["under a minute", "5 min", "2 h", "2 h 12 min", "3 d 8 h"]);
  // The page's script keeps the countdowns current and greys out a window once its reset passes.
  const script = /<script>\n([\s\S]*?)\n<\/script>/.exec(html)[1];
  assert.ok(script.includes(m.span.toString()), "the page uses the same countdown function");
  const ago = { dataset: { ago: iso(T0 - 5 * MIN) }, textContent: "" };
  const rel = { textContent: "" };
  const classes = new Set();
  const win = { dataset: { resets: iso(T0 + MIN) }, classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) }, querySelector: () => rel };
  const document = { querySelectorAll: (sel) => (sel === "[data-ago]" ? [ago] : [win]) };
  const run = (now) => new Function("document", "Date", "setInterval", script)(document, { now: () => now, parse: Date.parse }, () => {});
  run(T0);
  assert.deepEqual([ago.textContent, rel.textContent, classes.has("reset")], ["5 min ago", "(in 1 min)", false]);
  run(T0 + 2 * MIN);
  assert.deepEqual([rel.textContent, classes.has("reset")], ["", true]);
});

test("end to end: check files the reading, the status line links to the page, accounts lists and forgets", () => {
  const home = mkdtempSync(path.join(tmpdir(), "usage-accounts-e2e-"));
  const cfg = mkdtempSync(path.join(tmpdir(), "usage-accounts-e2e-cfg-"));
  saveLogin(cfg, { account: PERSONAL_SAVED, token: "sk-ant-oat-do-not-copy" });
  const fixture = path.join(home, "usage.json");
  writeFileSync(fixture, JSON.stringify({
    five_hour: { utilization: 64, resets_at: iso(Date.now() + 2 * H) },
    seven_day: { utilization: 49, resets_at: iso(Date.now() + 3 * 24 * H) },
  }));
  const env = {
    ...process.env, USAGE_HANDOFF_HOME: home, CLAUDE_CONFIG_DIR: cfg,
    USAGE_HANDOFF_CMD: `"${process.execPath}" -e "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))" "${fixture}"`,
  };
  const run = (...args) => execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });

  assert.equal(JSON.parse(run("check")).account, "lee@example.com");
  const url = pathToFileURL(path.join(home, "accounts.html")).href;
  const line = run("statusline").trim();
  assert.ok(line.startsWith(`${ESC}]8;;${url}\x07lee@example.com · 5h 64% (resets `), JSON.stringify(line));
  assert.ok(line.endsWith(`${ESC}]8;;\x07`));
  assert.ok(existsSync(path.join(home, "accounts.html")));
  assert.match(run("statusline", "--no-link"), /^lee@example\.com · 5h 64% \(resets [^)]+\) · week 49%/);
  // Claude Code pipes the session's JSON in; the model lands after the account
  const piped = execFileSync(process.execPath, [SCRIPT, "statusline", "--no-link"], {
    encoding: "utf8", env, input: JSON.stringify({ session_id: "abc", model: { id: "claude-opus-5-5", display_name: "Opus 5.5" } }),
  });
  assert.match(piped, /^lee@example\.com · Opus 5\.5 · 5h 64% \(resets [^)]+\) · week 49%/);

  const listed = run("accounts").trim();
  assert.match(listed, /^\* lee@example\.com \(Max 5x\) · 5h 64% \(resets .+\) · week 49% \(resets .+\) · logged in since /);
  assert.ok(listed.endsWith(`page: ${url}`));
  assert.equal(JSON.parse(run("accounts", "--json")).current, "u1/o1");
  assert.equal(JSON.parse(run("paths")).accounts, path.join(home, "accounts.html").replace(/\\/g, "/"));
  for (const f of readdirSync(home)) assert.ok(!readFileSync(path.join(home, f), "utf8").includes("sk-ant-oat-do-not-copy"), `${f} holds the token`);

  assert.match(run("accounts", "forget", "LEE@example.com"), /^forgot LEE@example\.com/);
  assert.match(run("accounts"), /^No accounts recorded yet/);
  assert.match(run("accounts", "forget", "nobody@example.com"), /^no account matches nobody@example\.com/);
});

test("the skill documents the accounts list and the status line's link", () => {
  const skill = readFileSync(skillFile("usage-handoff", "SKILL.md"), "utf8");
  assert.match(skill, /argument-hint: "[^"]*\| accounts\]/);
  assert.match(skill, /\*\*`accounts`\*\*/);
  assert.match(skill, /accounts forget <email>/);
  assert.match(skill, /--no-link/);
  assert.match(skill, /\*\*Every account:\*\*/);
});
