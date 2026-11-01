// Use case: tests/use-cases/new-project.md
// The interactive stages are prose for Claude; this covers the scaffolding they rely on and the
// skill's promises (stages recorded, outward steps gated, hand-offs to the other skills).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skillDir, skillFile, skillModule } from "../../scripts/layout.mjs";

const { STAGES } = await skillModule("project", "scripts/projects.mjs");
const { checkVision, compose, detect, docker, gitignore, vision } = await skillModule("new-project", "scripts/scaffold.mjs");
const SCAFFOLD = skillFile("new-project", "scripts", "scaffold.mjs");
const SKILL = readFileSync(skillFile("new-project", "SKILL.md"), "utf8");
const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
const noGithub = () => null;

test(".gitignore blocks merge into an existing file without duplicates, and keep .env out of git", () => {
  const dir = tmp("cpt-np-");
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n/custom\n");
  const added = gitignore(dir, ["node", "rust", "tauri", "docker"], { fetch: noGithub });
  assert.ok(added.includes(".env") && added.includes("target/") && added.includes("src-tauri/target/"));
  assert.ok(!added.includes("node_modules/"));
  const text = readFileSync(path.join(dir, ".gitignore"), "utf8");
  assert.match(text, /^\/custom$/m);
  assert.deepEqual(gitignore(dir, ["node", "rust"], { fetch: noGithub }), []);
  assert.throws(() => gitignore(dir, ["cobol"]), /unknown gitignore kind/);

  for (const f of [".env", ".env.local", ".env.example", "node_modules/x.js", "src-tauri/target/a"]) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), "x");
  }
  const status = execFileSync("git", ["-C", dir, "status", "--porcelain", "-uall"], { encoding: "utf8" });
  assert.match(status, /\.env\.example/);
  assert.doesNotMatch(status, /\.env\n|\.env\.local|node_modules|src-tauri\/target/);

  // GitHub's template replaces the bundled block when gh can fetch it.
  const gh = tmp("cpt-np-");
  gitignore(gh, ["node"], { github: true, fetch: (k) => (k === "node" ? "# from github\n.cache/\n" : null) });
  assert.match(readFileSync(path.join(gh, ".gitignore"), "utf8"), /^\.cache\/$/m);
});

test("VISION.md starts as a template, is never overwritten, and isn't ready until the owner fills it", () => {
  const dir = tmp("cpt-np-");
  const file = vision(dir, { name: "Habit Tracker", description: "Build habits with friends." });
  const template = readFileSync(file, "utf8");
  assert.match(template, /^# Habit Tracker: vision/);
  assert.equal(vision(dir), null);

  const blank = checkVision(template);
  assert.equal(blank.ok, false);
  assert.deepEqual(blank.requiredEmpty, ["The problem", "Who it's for", "What it does", "What success looks like"]);

  const filled = template
    .replace("## The problem\n", "## The problem\n\nPeople start habits alone and quit within two weeks because nobody notices when they slip.\n")
    .replace("## Who it's for\n", "## Who it's for\n\nAdults with a phone and a laptop who want a small group of friends to keep them honest.\n")
    .replace("## What it does\n", "## What it does\n\n- Track daily habits\n- Share streaks with a small circle\n- Nudge a friend who slipped\n");
  const partial = checkVision(filled);
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.requiredEmpty, ["What success looks like"]);

  const done = checkVision(filled.replace("## What success looks like\n", "## What success looks like\n\nHalf of new groups still check in daily after thirty days.\n"));
  assert.equal(done.ok, true, JSON.stringify(done));

  const r = spawnSync(process.execPath, [SCAFFOLD, "check-vision", file], { encoding: "utf8" });
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stdout).ok, false);
});

test("Docker files: Postgres with a healthcheck, a random local password, and nothing overwritten", () => {
  const dir = tmp("cpt-np-");
  const r = docker(dir, { name: "Habit Tracker", db: "postgres", web: true });
  assert.deepEqual(r.written.sort(), [".dockerignore", ".env", ".env.example", "Dockerfile", "compose.yaml", "nginx.conf"]);
  const yaml = readFileSync(path.join(dir, "compose.yaml"), "utf8");
  assert.match(yaml, /^name: habit-tracker$/m);
  assert.match(yaml, /image: postgres:\d+-alpine/);
  assert.match(yaml, /pg_isready/);
  assert.match(yaml, /127\.0\.0\.1:\$\{POSTGRES_PORT:-5432\}:5432/);
  assert.match(yaml, /condition: service_healthy/);
  const env = readFileSync(path.join(dir, ".env"), "utf8");
  const example = readFileSync(path.join(dir, ".env.example"), "utf8");
  assert.match(example, /POSTGRES_PASSWORD=change-me/);
  assert.doesNotMatch(env, /change-me/);
  assert.match(env, /POSTGRES_DB=habit_tracker/);

  const again = docker(dir, { name: "Habit Tracker", db: "postgres", web: true });
  assert.deepEqual(again.written, []);
  assert.equal(readFileSync(path.join(dir, ".env"), "utf8"), env);
  assert.throws(() => docker(dir, { name: "x", db: "mysql" }), /only postgres/);
  assert.doesNotMatch(compose("x", { web: true }), /depends_on|volumes:/);
});

test("detect reads what a project already is", () => {
  const dir = tmp("cpt-np-");
  mkdirSync(path.join(dir, "src-tauri", "gen", "android"), { recursive: true });
  writeFileSync(path.join(dir, "src-tauri", "tauri.conf.json"), "{}");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite", tauri: "tauri" }, devDependencies: { vite: "x", svelte: "x" } }));
  writeFileSync(path.join(dir, "package-lock.json"), "{}");
  docker(dir, { name: "app", db: "postgres" });
  const d = detect(dir);
  assert.equal(d.tauri, true);
  assert.deepEqual(d.mobile, { android: true, ios: false });
  assert.equal(d.framework, "svelte");
  assert.equal(d.db, "postgres");
  assert.equal(d.packageManager, "npm");
  assert.equal(d.vision, false);
});

test("the skill records every stage, gates the outward steps, and hands off to the other skills", () => {
  for (const [stage] of STAGES.slice(0, -1)) assert.ok(SKILL.includes(`stage=${stage}`), `new-project never records stage=${stage}`);
  assert.match(SKILL, /\*\*Private \(Recommended\)\*\*/);
  assert.match(SKILL, /Application: iPhone, Android, Windows, macOS, Linux and Web \(Tauri 2\)/);
  assert.match(SKILL, /invoke `ux-mockup`/);
  assert.match(SKILL, /Invoke `implement-to-pr`.*without `--merge`/);
  assert.match(SKILL, /Don't run it yourself/);
  // The skills it invokes must be invocable by the model.
  for (const name of ["ux-mockup", "implement-to-pr"]) {
    const text = readFileSync(path.join(skillDir(name), "SKILL.md"), "utf8");
    assert.match(text, /disable-model-invocation: false/, `${name} must be model-invocable for /new-project`);
  }
});
