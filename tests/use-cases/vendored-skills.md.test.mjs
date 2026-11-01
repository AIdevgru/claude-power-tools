// Use case: tests/use-cases/vendored-skills.md
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skillDir } from "../../scripts/layout.mjs";
import { REPO, lock, manifest, placed, sync, verify, versionOf } from "../../scripts/vendor.mjs";

const quiet = () => {};
const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
// A vendored skill's folder relative to the repo, to find the same file in a copy of it.
const rel = (name) => path.relative(REPO, skillDir(name));

// A copy of the repo's vendor manifest, lock and vendored files, to break on purpose.
function copyOfVendored() {
  const dir = tmp("cpt-vendored-");
  for (const f of ["vendor.json", "vendor.lock.json"]) cpSync(path.join(REPO, f), path.join(dir, f));
  for (const l of Object.values(lock())) {
    for (const f of Object.keys(l.files)) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      cpSync(path.join(REPO, f), path.join(dir, f));
    }
  }
  return dir;
}

test("the vendored files match the upstream copies recorded in the lock", () => {
  assert.deepEqual(verify(), []);
  const names = Object.keys(manifest());
  assert.deepEqual(names.sort(), ["graphify", "impeccable"]);
  for (const name of names) {
    const l = lock()[name];
    assert.match(l.commit, /^[0-9a-f]{40}$/, name);
    assert.equal(l.ref, manifest()[name].ref);
    assert.ok(existsSync(path.join(skillDir(name), "SKILL.md")), name);
    assert.ok(existsSync(path.join(skillDir(name), "LICENSE")), `${name} ships its LICENSE`);
  }
  assert.equal(readFileSync(path.join(skillDir("graphify"), ".graphify_version"), "utf8"), versionOf(manifest().graphify.ref));
});

test("a local edit, an added file or a deleted file is caught", () => {
  const dir = copyOfVendored();
  assert.deepEqual(verify(dir), []);

  const polish = path.join(dir, rel("impeccable"), "reference", "polish.md");
  writeFileSync(polish, readFileSync(polish, "utf8").replace("polish", "polsh"));
  writeFileSync(path.join(dir, rel("graphify"), "references", "mine.md"), "local notes\n");
  rmSync(path.join(dir, rel("graphify"), "NOTICE"));

  const problems = verify(dir).join("\n");
  assert.match(problems, /reference\/polish\.md: changed from upstream skill-v4\.8\.0/);
  assert.match(problems, /references\/mine\.md: not from upstream/);
  assert.match(problems, /extras\/graphify\/NOTICE: missing/);
});

test("the Impeccable .cmd launcher keeps CRLF line endings", () => {
  const cmd = readFileSync(path.join(skillDir("impeccable"), "scripts", "impeccable.cmd"), "latin1");
  assert.ok(cmd.includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(cmd), "bare LF in impeccable.cmd");
  assert.ok(!readFileSync(path.join(skillDir("impeccable"), "SKILL.md"), "latin1").includes("\r\n"));
});

test("sync copies the mapped files, drops stale ones, and records a new ref", () => {
  const repo = tmp("cpt-vendor-repo-");
  writeFileSync(path.join(repo, "vendor.json"), JSON.stringify({
    $comment: "test",
    demo: {
      repo: "https://example.invalid/demo", ref: "v1.0.0", license: "MIT",
      files: { "extras/demo": "skill", "extras/demo/LICENSE": "LICENSE" },
      generated: { "extras/demo/.demo_version": "{version}" },
    },
  }));
  const upstream = (files) => (entry, ref) => {
    const dir = tmp("cpt-vendor-up-");
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), text);
    }
    return { dir, commit: ref === "v1.0.0" ? "a".repeat(40) : "b".repeat(40) };
  };

  sync("demo", { repo, log: quiet, fetch: upstream({ "skill/SKILL.md": "one\n", "skill/old.md": "old\n", LICENSE: "MIT\n" }) });
  assert.deepEqual(verify(repo), []);
  assert.equal(readFileSync(path.join(repo, "extras/demo/.demo_version"), "utf8"), "1.0.0");
  assert.ok(existsSync(path.join(repo, "extras/demo/old.md")));

  sync("demo", { repo, ref: "v1.1.0", log: quiet, fetch: upstream({ "skill/SKILL.md": "two\n", LICENSE: "MIT\n" }) });
  assert.deepEqual(verify(repo), []);
  assert.equal(existsSync(path.join(repo, "extras/demo/old.md")), false, "a file upstream dropped is removed");
  assert.equal(readFileSync(path.join(repo, "extras/demo/SKILL.md"), "utf8"), "two\n");
  const m = JSON.parse(readFileSync(path.join(repo, "vendor.json"), "utf8"));
  assert.equal(m.demo.ref, "v1.1.0");
  assert.equal(m.$comment, "test");
  assert.equal(lock(repo).demo.commit, "b".repeat(40));
  assert.equal(readFileSync(path.join(repo, "extras/demo/.demo_version"), "utf8"), "1.1.0");

  assert.throws(() => sync("nope", { repo, log: quiet, fetch: upstream({}) }), /no "nope"/);
  assert.throws(() => sync("demo", { repo, log: quiet, fetch: upstream({ LICENSE: "x" }) }), /upstream has no skill/);
});

test("vendored files land inside a plugin's skills or agents folder, or in extras", () => {
  assert.ok(placed("plugins/power-tools-ui/skills/impeccable/SKILL.md"));
  assert.ok(placed("plugins/power-tools-ui/agents/impeccable-documenter.md"));
  assert.ok(placed("extras/graphify/SKILL.md"));
  assert.ok(!placed("skills/impeccable/SKILL.md"), "the pre-0.6 root skills/ folder is in no plugin");
  assert.ok(!placed("plugins/power-tools-ui/README.md"));
  const repo = tmp("cpt-vendor-place-");
  writeFileSync(path.join(repo, "vendor.json"), JSON.stringify({ demo: { repo: "x", ref: "v1", files: { "skills/demo": "skill" } } }));
  assert.match(verify(repo).join("\n"), /demo: skills\/demo is outside every plugin/);
});

test("versions come from tags", () => {
  assert.equal(versionOf("v0.9.96"), "0.9.96");
  assert.equal(versionOf("skill-v4.8.0"), "4.8.0");
  assert.equal(versionOf("1.2.3"), "1.2.3");
});
