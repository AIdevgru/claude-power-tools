// Use case: tests/use-cases/project.md
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skillFile, skillModule } from "../../scripts/layout.mjs";
const { addProject, addRoot, find, hookLine, load, nextStep, removeRoot, scan, setFields, STAGES } = await skillModule("project", "scripts/projects.mjs");
const { resolveFile, serve } = await skillModule("project", "scripts/serve.mjs");

const SCRIPT = skillFile("project", "scripts", "projects.mjs");
const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
const cli = (home, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, POWER_TOOLS_HOME: home } });

test("roots: the first is the default, --create makes a folder, forgetting moves the default", () => {
  const reg = { roots: [], projects: [] };
  const work = tmp("cpt-proj-work-");
  const side = path.join(tmp("cpt-proj-side-"), "side");
  addRoot(reg, work);
  assert.equal(reg.roots[0].default, true);
  assert.throws(() => addRoot(reg, side), /does not exist/);
  addRoot(reg, side, { create: true });
  assert.ok(existsSync(side));
  assert.equal(reg.roots.filter((r) => r.default).length, 1);
  addRoot(reg, side, { makeDefault: true });
  assert.equal(reg.roots.find((r) => r.default).path, path.resolve(side));
  removeRoot(reg, side);
  assert.equal(reg.roots[0].default, true);
});

test("the CLI saves the registry, lists projects with their stage, and forgets without deleting", () => {
  const home = tmp("cpt-proj-home-");
  const root = tmp("cpt-proj-root-");
  const app = path.join(root, "habit-tracker");
  mkdirSync(app);
  assert.equal(cli(home, "add-root", root).status, 0);
  assert.match(cli(home, "roots").stdout, /^\* /);
  assert.equal(cli(home, "add", app).status, 0);
  assert.equal(cli(home, "set", "habit-tracker", "stage=mockup", "kind=app", "url.app=https://example.com").status, 0);
  assert.equal(cli(home, "set", "habit-tracker", "stage=bogus").status, 1);
  const list = cli(home, "list").stdout;
  assert.match(list, /habit-tracker .* mockup · app/);
  const json = JSON.parse(cli(home, "get", "habit-tracker", "--json").stdout);
  assert.equal(json.url.app, "https://example.com");
  assert.match(json.created, /Z$/);

  rmSync(app, { recursive: true });
  assert.match(cli(home, "list").stdout, /\[folder missing\]/);
  mkdirSync(app);
  assert.equal(cli(home, "remove", "habit-tracker").status, 0);
  assert.ok(existsSync(app));
  assert.equal(load(home).projects.length, 0);
});

test("scan finds unregistered git repos under the roots", () => {
  const root = tmp("cpt-proj-root-");
  for (const name of ["a", "b"]) execFileSync("git", ["init", "-q", path.join(root, name)]);
  mkdirSync(path.join(root, "not-a-repo"));
  const reg = { roots: [], projects: [] };
  addRoot(reg, root);
  addProject(reg, path.join(root, "a"));
  assert.deepEqual(scan(reg), [path.join(root, "b")]);
});

test("the session-start hook names the next step inside unfinished projects only", () => {
  const reg = { roots: [], projects: [] };
  const app = tmp("cpt-proj-app-");
  const p = addProject(reg, app, { name: "habit-tracker" });
  setFields(p, ["stage=mockup"]);
  const line = hookLine(reg, path.join(app, "src"));
  assert.match(line, /"habit-tracker" is at stage "mockup"/);
  assert.match(line, /\/new-project resume habit-tracker/);
  assert.equal(hookLine(reg, tmpdir()), "");
  setFields(p, ["stage=deployed"]);
  assert.equal(hookLine(reg, app), "");
  assert.equal(nextStep("deployed"), null);
  assert.equal(STAGES.at(-1)[0], "deployed");
  assert.equal(find(reg, app), p);

  // The hook process itself: one line in, silence on bad input.
  const home = tmp("cpt-proj-home-");
  const reg2 = { roots: [], projects: [] };
  setFields(addProject(reg2, app, { name: "habit-tracker" }), ["stage=docs"]);
  writeFileSync(path.join(home, "projects.json"), JSON.stringify(reg2));
  const hook = (input) => spawnSync(process.execPath, [SCRIPT, "--hook"], { input, encoding: "utf8", env: { ...process.env, POWER_TOOLS_HOME: home } });
  assert.match(hook(JSON.stringify({ cwd: app })).stdout, /stage "docs"/);
  assert.equal(hook("{ broken").stdout, "");
  assert.equal(hook("{ broken").status, 0);
});

test("the static server serves index.html, blocks escapes, and never caches", async () => {
  const site = tmp("cpt-serve-");
  writeFileSync(path.join(site, "index.html"), "<title>Mockup</title>");
  mkdirSync(path.join(site, "assets"));
  writeFileSync(path.join(site, "assets", "app.css"), "body{}");
  assert.equal(resolveFile(site, "/"), path.join(site, "index.html"));
  writeFileSync(path.join(path.dirname(site), "outside.txt"), "secret");
  assert.equal(resolveFile(site, "/../outside.txt"), null);
  assert.equal(resolveFile(site, "/%2e%2e/secret"), null);

  const { server, url } = await serve(site, { port: 5310 });
  let second = null;
  try {
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(await page.text(), /Mockup/);
    const css = await fetch(new URL("assets/app.css", url));
    assert.match(css.headers.get("content-type"), /text\/css/);
    assert.equal((await fetch(new URL("missing.png", url))).status, 404);
    // A second server on the same port moves to the next free one.
    second = await serve(site, { port: Number(new URL(url).port) });
    assert.notEqual(second.url, url);
  } finally {
    second?.server.close();
    // fetch keeps connections alive; drop them so the test process can exit.
    server.closeAllConnections();
    server.close();
  }
});
