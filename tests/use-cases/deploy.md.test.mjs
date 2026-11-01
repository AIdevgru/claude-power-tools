// Use case: tests/use-cases/deploy.md
// Deployment itself runs in GitHub Actions; this checks the workflow templates and the skill's
// safety promises.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { skillDir } from "../../scripts/layout.mjs";

const DIR = skillDir("deploy");
const SKILL = readFileSync(path.join(DIR, "SKILL.md"), "utf8");
const templates = readdirSync(path.join(DIR, "templates", "workflows"));

test("every workflow template exists, pins its actions and is named in the skill", () => {
  assert.deepEqual(templates.sort(), ["cloudflare-pages.yml", "fly.yml", "pages.yml", "tauri-release.yml"]);
  for (const t of templates) {
    const text = readFileSync(path.join(DIR, "templates", "workflows", t), "utf8");
    assert.ok(SKILL.includes(t), `${t} isn't mentioned in deploy/SKILL.md`);
    assert.match(text, /^on:$/m, t);
    assert.match(text, /^permissions:$/m, `${t} must declare least-privilege permissions`);
    assert.doesNotMatch(text, /\t/, `${t} has a tab`);
    for (const [, action, ref] of text.matchAll(/uses:\s*([\w.-]+\/[\w./-]+)@([\w.-]+)/g)) {
      // flyctl's setup action is only published from master.
      if (action !== "superfly/flyctl-actions/setup-flyctl") assert.match(ref, /^v\d+$|^stable$/, `${t}: ${action}@${ref} isn't pinned to a major`);
    }
    assert.ok([...text.matchAll(/uses:/g)].length >= 2, t);
    // Secrets are referenced, never written in.
    assert.doesNotMatch(text, /(token|key|password)\s*:\s*['"]?[A-Za-z0-9_-]{16,}/i, t);
  }
});

test("pages.yml deploys site/ with the Pages actions and the right permissions", () => {
  const text = readFileSync(path.join(DIR, "templates", "workflows", "pages.yml"), "utf8");
  assert.match(text, /pages: write/);
  assert.match(text, /id-token: write/);
  assert.match(text, /path: site/);
  assert.match(text, /actions\/deploy-pages@/);
});

test("the skill keeps deployment explicit, approved, secret-free and in CI", () => {
  assert.match(SKILL, /disable-model-invocation: true/);
  assert.match(SKILL, /Nothing outward-facing happens before "Go ahead"/);
  assert.match(SKILL, /! gh secret set <NAME>/);
  assert.match(SKILL, /Never ask for a token in chat/);
  assert.match(SKILL, /never work around a failure by deploying by hand/);
  assert.match(SKILL, /paid GitHub plan/);
  assert.match(SKILL, /ui-critique-loop --score/);
  assert.match(SKILL, /\/impeccable shape/);
});
