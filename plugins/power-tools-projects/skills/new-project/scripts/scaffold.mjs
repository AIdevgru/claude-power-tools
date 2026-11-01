#!/usr/bin/env node
// File scaffolding for /new-project and /deploy. It never overwrites a file the project already
// has: .gitignore entries are merged, and every other file is skipped if it exists.
//
//   node scaffold.mjs gitignore <dir> --kinds base,node,rust,tauri,python,docker [--github]
//   node scaffold.mjs vision <dir> [--name N] [--description D]
//   node scaffold.mjs check-vision <file>          JSON; exit 3 while sections are still empty
//   node scaffold.mjs docker <dir> --name N [--db postgres] [--web]
//   node scaffold.mjs detect <dir>                 JSON: tauri, mobile targets, vite, framework, docker, db
//
// --github takes the Node, Rust and Python blocks from GitHub's gitignore templates (gh api)
// when gh is signed in, and the bundled copies otherwise.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
export const GITIGNORE_KINDS = ["base", "node", "rust", "tauri", "python", "docker"];
const GITHUB_NAMES = { node: "Node", rust: "Rust", python: "Python" };

const read = (p) => readFileSync(p, "utf8");
const lines = (text) => text.split(/\r?\n/).map((l) => l.trim());

function githubTemplate(kind) {
  const name = GITHUB_NAMES[kind];
  if (!name) return null;
  const r = spawnSync("gh", ["api", `gitignore/templates/${name}`, "--jq", ".source"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? r.stdout : null;
}

// Merges the kinds' blocks into <dir>/.gitignore. Returns the entries it added.
export function gitignore(dir, kinds, { github = false, fetch = githubTemplate } = {}) {
  const unknown = kinds.filter((k) => !GITIGNORE_KINDS.includes(k));
  if (unknown.length) throw new Error(`unknown gitignore kind(s): ${unknown.join(", ")}; kinds: ${GITIGNORE_KINDS.join(", ")}`);
  const file = path.join(dir, ".gitignore");
  let text = existsSync(file) ? read(file) : "";
  const have = new Set(lines(text).filter((l) => l && !l.startsWith("#")));
  const added = [];
  for (const kind of ["base", ...kinds.filter((k) => k !== "base")]) {
    const source = (github && fetch(kind)) || read(path.join(TEMPLATES, "gitignore", `${kind}.gitignore`));
    const fresh = lines(source).filter((l) => l && !l.startsWith("#") && !have.has(l));
    if (!fresh.length) continue;
    for (const l of fresh) have.add(l);
    added.push(...fresh);
    text += `${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}# ${kind}\n${fresh.join("\n")}\n`;
  }
  if (added.length) writeFileSync(file, text);
  return added;
}

export function vision(dir, { name = path.basename(path.resolve(dir)), description = "" } = {}) {
  const file = path.join(dir, "VISION.md");
  if (existsSync(file)) return null;
  const text = read(path.join(TEMPLATES, "VISION.md")).replaceAll("{{name}}", name).replaceAll("{{description}}", description || "<!-- One sentence: what it is and who it is for. -->");
  writeFileSync(file, text);
  return file;
}

const REQUIRED = ["The problem", "Who it's for", "What it does", "What success looks like"];

// Which VISION.md sections still hold only the template's prompts.
export function checkVision(text) {
  const body = text.replace(/<!--[\s\S]*?-->/g, "");
  const sections = {};
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) sections[(current = h[1])] = "";
    else if (current) sections[current] += `${line}\n`;
  }
  const words = (s) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).filter((w) => !/^todo$/i.test(w)).length;
  const empty = Object.keys(sections).filter((s) => words(sections[s]) < 3);
  const missing = REQUIRED.filter((s) => !(s in sections));
  const total = Object.values(sections).reduce((n, s) => n + words(s), 0);
  const requiredEmpty = REQUIRED.filter((s) => s in sections && empty.includes(s));
  return { ok: !missing.length && !requiredEmpty.length && total >= 40, words: total, emptySections: empty, missingSections: missing, requiredEmpty };
}

const dbName = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "app";

export function compose(name, { db = null, web = false } = {}) {
  const out = [`name: ${name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`, "services:"];
  if (db === "postgres") {
    out.push(
      "  db:",
      "    image: postgres:18-alpine",
      "    restart: unless-stopped",
      "    environment:",
      `      POSTGRES_DB: \${POSTGRES_DB:-${dbName(name)}}`,
      "      POSTGRES_USER: ${POSTGRES_USER:-app}",
      "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}",
      "    ports:",
      '      - "127.0.0.1:${POSTGRES_PORT:-5432}:5432"',
      "    volumes:",
      "      - pgdata:/var/lib/postgresql",
      "    healthcheck:",
      '      test: ["CMD-SHELL", "pg_isready -U \\"$${POSTGRES_USER}\\" -d \\"$${POSTGRES_DB}\\""]',
      "      interval: 5s",
      "      timeout: 5s",
      "      retries: 10",
    );
  }
  if (web) {
    out.push("  web:", "    build: .", "    restart: unless-stopped", "    ports:", '      - "127.0.0.1:${WEB_PORT:-8080}:80"');
    if (db) out.push("    depends_on:", "      db:", "        condition: service_healthy");
  }
  if (db === "postgres") out.push("volumes:", "  pgdata:");
  return out.join("\n") + "\n";
}

// Writes compose.yaml, .env.example and .env (random password, gitignored), plus the web image
// files with --web. Returns { written, skipped }.
export function docker(dir, { name, db = null, web = false } = {}) {
  if (!name) throw new Error("docker needs --name");
  if (db && db !== "postgres") throw new Error(`unsupported --db ${db}; only postgres`);
  const written = [];
  const skipped = [];
  const put = (rel, text) => {
    const p = path.join(dir, rel);
    if (existsSync(p)) return skipped.push(rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
    written.push(rel);
  };
  put("compose.yaml", compose(name, { db, web }));
  if (db === "postgres") {
    const env = (password) => [
      `POSTGRES_DB=${dbName(name)}`, "POSTGRES_USER=app", `POSTGRES_PASSWORD=${password}`, "POSTGRES_PORT=5432",
      `DATABASE_URL=postgres://app:${password}@localhost:5432/${dbName(name)}`, "",
    ].join("\n");
    put(".env.example", env("change-me"));
    put(".env", env(randomBytes(18).toString("base64url")));
  }
  if (web) {
    put("Dockerfile", read(path.join(TEMPLATES, "docker", "Dockerfile.web")));
    put("nginx.conf", read(path.join(TEMPLATES, "docker", "nginx.conf")));
    put(".dockerignore", read(path.join(TEMPLATES, "docker", "dockerignore")));
  }
  return { written, skipped };
}

export function detect(dir) {
  const has = (rel) => existsSync(path.join(dir, rel));
  let pkg = {};
  try {
    pkg = JSON.parse(read(path.join(dir, "package.json")));
  } catch {
    // no package.json
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const framework = ["@sveltejs/kit", "svelte", "next", "react", "vue", "solid-js", "@angular/core", "preact"].find((d) => deps[d]) ?? null;
  const composeFile = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"].find(has);
  const composeText = composeFile ? read(path.join(dir, composeFile)) : "";
  const viteConfig = existsSync(dir) ? readdirSync(dir).some((f) => /^vite\.config\.(js|ts|mjs|mts)$/.test(f)) : false;
  return {
    tauri: has("src-tauri/tauri.conf.json") || has("src-tauri/Tauri.toml"),
    mobile: { android: has("src-tauri/gen/android"), ios: has("src-tauri/gen/apple") },
    vite: viteConfig || Boolean(deps.vite),
    framework,
    docker: has("Dockerfile"),
    compose: composeFile ?? null,
    db: /image:\s*postgres/i.test(composeText) ? "postgres" : null,
    packageManager: has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : has("package.json") ? "npm" : null,
    scripts: Object.keys(pkg.scripts ?? {}),
    vision: has("VISION.md"),
    plan: has("docs/implementation-plan.md"),
  };
}

function main(argv) {
  const [cmd, dirArg, ...rest] = argv;
  const opt = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const dir = path.resolve(dirArg ?? ".");
  switch (cmd) {
    case "gitignore": {
      const kinds = (opt("--kinds") ?? "base").split(",").map((s) => s.trim()).filter(Boolean);
      const added = gitignore(dir, kinds, { github: rest.includes("--github") });
      console.log(added.length ? `.gitignore: added ${added.length} entr${added.length === 1 ? "y" : "ies"}` : ".gitignore: already complete");
      return 0;
    }
    case "vision": {
      const file = vision(dir, { name: opt("--name"), description: opt("--description") });
      console.log(file ? `wrote ${file.replace(/\\/g, "/")}` : "VISION.md already exists; left it alone");
      return 0;
    }
    case "check-vision": {
      const result = checkVision(read(dir));
      console.log(JSON.stringify(result));
      return result.ok ? 0 : 3;
    }
    case "docker": {
      const r = docker(dir, { name: opt("--name"), db: opt("--db") ?? null, web: rest.includes("--web") });
      console.log(`wrote: ${r.written.join(", ") || "nothing"}${r.skipped.length ? `\nskipped (already there): ${r.skipped.join(", ")}` : ""}`);
      return 0;
    }
    case "detect":
      console.log(JSON.stringify(detect(dir), null, 2));
      return 0;
    default:
      throw new Error("usage: scaffold.mjs gitignore|vision|check-vision|docker|detect <dir> [options]");
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
