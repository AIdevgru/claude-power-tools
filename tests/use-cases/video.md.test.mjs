// Use case: tests/use-cases/video.md
// No npm, network or Remotion here: the pure parts of video.mjs, the template and the skill text.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pluginOf, skillDir, skillFile, skillModule } from "../../scripts/layout.mjs";

const SCRIPT = skillFile("video", "scripts", "video.mjs");
const SKILL = readFileSync(skillFile("video", "SKILL.md"), "utf8");
const REF = readFileSync(skillFile("video", "reference", "remotion.md"), "utf8");
const TEMPLATE = skillFile("video", "templates", "remotion");
const V = await skillModule("video", "scripts/video.mjs");
const tmp = () => mkdtempSync(path.join(tmpdir(), "video-"));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", windowsHide: true });

test("/video ships in power-tools-ui, Claude may pick it, and its hint shows the plan flags", () => {
  assert.equal(pluginOf("video"), "power-tools-ui");
  assert.match(SKILL, /^name: video$/m);
  assert.match(SKILL, /^user-invocable: true$/m);
  assert.match(SKILL, /^disable-model-invocation: false$/m);
  const hint = /^argument-hint: "(.*)"$/m.exec(SKILL)?.[1] ?? "";
  for (const flag of ["--length", "--size", "--fps"]) assert.ok(hint.includes(flag), `argument-hint lacks ${flag}`);
  assert.match(SKILL, /Trigger on '\/video/);
  assert.ok(existsSync(path.join(skillDir("video"), "..", "..", "evals", "triggers", "video", "prompt.md")), "trigger eval");
});

test("the skill runs the steps in order: doctor, plan, paths, storyboard, init, install, stills it looks at, render, report", () => {
  const order = ["VIDEO doctor", "VIDEO plan", "VIDEO paths", "## Step 2: storyboard", "VIDEO init", "VIDEO install", "VIDEO still", "Read tool", "VIDEO render", "## Step 7: report"];
  let at = -1;
  for (const s of order) {
    const i = SKILL.indexOf(s, at + 1);
    assert.ok(i > at, `"${s}" is missing or out of order`);
    at = i;
  }
  assert.match(SKILL, /`VIDEO` below means `node "<this skill's base directory>\/scripts\/video\.mjs"`/);
  assert.match(SKILL, /\*\*20 s, 1080p \(1920x1080, 16:9\) and 30 fps\*\*/, "the defaults are stated");
  assert.match(SKILL, /Ask only when the video can't be made without the answer/);
  assert.match(SKILL, /at most 3 rounds/, "the still review is bounded");
  assert.match(SKILL, /must add up to the plan's `frames`/);
  assert.match(SKILL, /\[reference\/remotion\.md\]\(reference\/remotion\.md\)/);
});

test("the skill states Remotion's license and the content and audio rules", () => {
  assert.match(SKILL, /free for individuals, for-profit companies with up to 3 employees, non-profits, and for evaluating it\. Any other company needs a Remotion Company License/);
  assert.match(SKILL, /Never use copyrighted characters, logos or music the owner didn't supply/);
  assert.match(SKILL, /never recreate a specific existing video, ad or brand look they don't own/);
  assert.match(SKILL, /Use a music or voice file only if the owner gives one/);
  assert.match(SKILL, /no text-to-speech tool, put the words on screen as captions and say so/);
  assert.match(SKILL, /Never `npm install` a Remotion package yourself/);
  assert.match(SKILL, /Don't commit, stage or push/);
});

test("the reference keeps every frame a pure function of the frame number, and 3D on useCurrentFrame", () => {
  assert.match(REF, /Never use CSS transitions or `@keyframes`, `setTimeout`, `requestAnimationFrame`, `Date\.now\(\)` or\s+`Math\.random\(\)`/);
  assert.match(REF, /never from react-three-fiber's `useFrame\(\)`/);
  assert.match(REF, /`layout="none"`/);
  assert.match(REF, /--gl=swangle/);
  assert.match(REF, /the\s+total is the sum of the parts minus the sum of the transitions/);
});

test("plan reads lengths, sizes and fps, and refuses what H.264 or the limits can't take", () => {
  const p = V.plan();
  assert.deepEqual([p.fps, p.frames, p.seconds, p.width, p.height, p.aspect], [30, 600, 20, 1920, 1080, "16:9"]);
  assert.equal(p.summary, "20 s at 30 fps = 600 frames, 1920x1080 (16:9)");
  const frames = (t, fps = 30) => V.parseLength(t, fps).frames;
  assert.equal(frames("20s"), 600);
  assert.equal(frames("20"), 600);
  assert.equal(frames("2.5s"), 75);
  assert.equal(frames("1m"), 1800);
  assert.equal(frames("1m30s"), 2700);
  assert.equal(frames("1:30"), 2700);
  assert.equal(frames("90 seconds"), 2700);
  assert.equal(frames("450f"), 450);
  assert.equal(frames("10s", 60), 600);
  assert.equal(V.parseLength("450f", 30).seconds, 15);
  for (const bad of ["", "soon", "5ms", "1:75", "0s", "11m", "-5s"]) assert.throws(() => V.parseLength(bad, 30), undefined, bad);

  const size = (t) => { const s = V.parseSize(t); return `${s.width}x${s.height}`; };
  assert.equal(size("1080p"), "1920x1080");
  assert.equal(size("720p"), "1280x720");
  assert.equal(size("4K"), "3840x2160");
  assert.equal(size("vertical"), "1080x1920");
  assert.equal(size("9:16"), "1080x1920");
  assert.equal(size("square"), "1080x1080");
  assert.equal(size("portrait"), "1080x1350");
  assert.equal(size("1280x720"), "1280x720");
  assert.throws(() => V.parseSize("1081x720"), /even width and height/);
  assert.throws(() => V.parseSize("8000x8000"), /outside/);
  assert.throws(() => V.parseSize("huge"), /can't read the size/);
  assert.throws(() => V.parseSize("toString"), /can't read the size/, "prototype names aren't sizes");

  assert.equal(V.parseFps("24"), 24);
  for (const bad of ["0", "121", "29.97", "fast"]) assert.throws(() => V.parseFps(bad), /fps/, bad);
  assert.equal(V.plan({ length: "15s", size: "square", fps: "60" }).summary, "15 s at 60 fps = 900 frames, 1080x1080 (1:1)");
});

test("paths go to <repo>/videos/<date>-<slug>/ in a git repo and ~/.claude/video/ outside one, never into an old folder", () => {
  const date = new Date(2026, 10, 10);
  const repo = path.resolve("/work/tool");
  const inRepo = (taken = []) => (p) => p === path.join(repo, ".git") || taken.includes(p);
  const a = V.outputPaths({ slug: "CLI Teaser!", cwd: path.join(repo, "src"), home: path.resolve("/home/p"), date, exists: inRepo() });
  assert.equal(a.root, path.join(repo, "videos", "2026-11-10-cli-teaser"));
  assert.equal(a.project, path.join(a.root, "project"));
  assert.equal(a.storyboard, path.join(a.root, "storyboard.md"));
  assert.equal(a.stills, path.join(a.root, "project", "out", "stills"));
  assert.equal(a.video, path.join(a.root, "cli-teaser.mp4"));
  assert.equal(a.inRepo, true);
  const again = V.outputPaths({ slug: "cli-teaser", cwd: repo, date, exists: inRepo([a.root, `${a.root}-2`]) });
  assert.equal(again.root, `${a.root}-3`);
  const out = V.outputPaths({ slug: "x", cwd: path.resolve("/tmp/scratch"), home: path.resolve("/home/p"), date, exists: () => false });
  assert.equal(out.root, path.join(path.resolve("/home/p"), ".claude", "video", "2026-11-10-x"));
  assert.equal(out.inRepo, false);

  assert.equal(V.slugify("A 20 second product teaser for our CLI, dark theme"), "a-20-second-product-teaser-for-our-cli");
  assert.equal(V.slugify("Café déjà vu"), "cafe-deja-vu");
  assert.equal(V.slugify("!!!"), "video");
  assert.equal(V.dateStamp(new Date(2026, 0, 5)), "2026-01-05");
});

test("the template is a minimal Remotion project: exact pins, one Remotion version, a 2D and a three.js scene", () => {
  const pkg = JSON.parse(readFileSync(path.join(TEMPLATE, "package.json"), "utf8"));
  assert.deepEqual(V.checkPins(pkg), []);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of ["remotion", "@remotion/cli", "@remotion/three", "three", "@react-three/fiber", "react", "react-dom"]) assert.ok(deps[name], name);
  assert.equal(new Set(Object.entries(deps).filter(([n]) => n === "remotion" || n.startsWith("@remotion/")).map(([, v]) => v)).size, 1);
  assert.ok(!existsSync(path.join(TEMPLATE, "node_modules")), "node_modules isn't committed");
  assert.match(readFileSync(path.join(TEMPLATE, "gitignore"), "utf8"), /^node_modules\/$/m);
  assert.match(readFileSync(path.join(TEMPLATE, "remotion.config.ts"), "utf8"), /setChromiumOpenGlRenderer\("angle"\)/);
  assert.match(readFileSync(path.join(TEMPLATE, "src", "index.ts"), "utf8"), /registerRoot\(RemotionRoot\)/);
  assert.match(readFileSync(path.join(TEMPLATE, "src", "Root.tsx"), "utf8"), /id="Main"/);
  const spin = readFileSync(path.join(TEMPLATE, "src", "scenes", "SpinScene.tsx"), "utf8");
  assert.match(spin, /from "@remotion\/three"/);
  assert.match(spin, /useCurrentFrame\(\)/);
  assert.ok(!/useFrame\b/.test(spin.replace(/useFrame\(\)\./g, "")), "3D motion comes from the frame number");
  assert.match(readFileSync(path.join(TEMPLATE, "src", "scenes", "TitleScene.tsx"), "utf8"), /spring\(/);
  assert.equal(readFileSync(path.join(TEMPLATE, "src", "settings.ts"), "utf8").replace(/\r\n/g, "\n"), V.settingsSource(V.plan()), "the template's settings are the default plan");

  assert.deepEqual(V.checkPins({ dependencies: { remotion: "^4.0.0" } }), ["remotion@^4.0.0 isn't an exact version"]);
  assert.match(V.checkPins({ dependencies: { remotion: "4.0.1", "@remotion/three": "4.0.2" } }).join(), /different versions/);
  assert.match(V.checkPins({ dependencies: { react: "19.0.0" } }).join(), /remotion isn't a dependency/);
});

test("init copies the template, writes the plan into settings.ts, and refuses a folder that isn't empty", () => {
  const dir = tmp();
  try {
    const target = path.join(dir, "project");
    const r = V.init(target, V.plan({ length: "4s", size: "vertical" }));
    assert.equal(r.dir, target);
    assert.ok(existsSync(path.join(target, ".gitignore")) && !existsSync(path.join(target, "gitignore")), "gitignore becomes .gitignore");
    for (const f of ["package.json", "remotion.config.ts", "tsconfig.json", "src/index.ts", "src/Root.tsx", "src/Main.tsx"]) assert.ok(existsSync(path.join(target, f)), f);
    const settings = readFileSync(path.join(target, "src", "settings.ts"), "utf8");
    assert.match(settings, /width: 1080,\n {2}height: 1920,\n {2}durationInFrames: 120,/);
    assert.throws(() => V.init(target), /isn't empty/);
    mkdirSync(path.join(dir, "empty"));
    V.init(path.join(dir, "empty"));
    const busy = path.join(dir, "busy");
    mkdirSync(busy);
    writeFileSync(path.join(busy, "notes.txt"), "mine");
    assert.throws(() => V.init(busy), /isn't empty/);
    assert.deepEqual(readdirSync(busy), ["notes.txt"], "nothing is copied over someone's files");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("add pins every @remotion/* package to the project's remotion version and refuses what isn't a package", () => {
  assert.deepEqual(V.pinPackages(["@remotion/lottie", "lottie-web", "d3-scale@4.0.3"], "4.0.542"), ["@remotion/lottie@4.0.542", "lottie-web", "d3-scale@4.0.3"]);
  assert.deepEqual(V.pinPackages(["@remotion/media@4.0.542"], "4.0.542"), ["@remotion/media@4.0.542"]);
  assert.throws(() => V.pinPackages(["@remotion/media@4.0.1"], "4.0.542"), /must be 4\.0\.542/);
  for (const bad of ["--global", "a b", "x;rm", "%PATH%", 'a"b']) assert.throws(() => V.pinPackages([bad], "4.0.542"), /not a package name/, bad);
  assert.throws(() => V.pinPackages([], "4.0.542"), /at least one/);
  assert.deepEqual(V.splitSpec("@remotion/three@4.0.1"), ["@remotion/three", "4.0.1"]);
  assert.deepEqual(V.splitSpec("three"), ["three", null]);
});

test("npm runs through node's own npm-cli.js where it can, else a quoted npm.cmd line on Windows", () => {
  const winNode = "C:\\Program Files\\nodejs\\node.exe";
  const winCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  assert.deepEqual(V.npmCommand(["install"], { platform: "win32", env: {}, node: winNode, exists: (f) => f === winCli }), { file: winNode, args: [winCli, "install"], shell: false });
  const nvm = "/home/p/.nvm/versions/node/v22.1.0/bin/node";
  const nvmCli = "/home/p/.nvm/versions/node/v22.1.0/lib/node_modules/npm/bin/npm-cli.js";
  assert.deepEqual(V.npmCommand(["ci"], { platform: "linux", env: {}, node: nvm, exists: (f) => f === nvmCli }), { file: nvm, args: [nvmCli, "ci"], shell: false });
  assert.deepEqual(V.npmCommand(["ci"], { platform: "linux", env: {}, node: "/usr/bin/node", exists: () => false }), { file: "npm", args: ["ci"], shell: false });

  // A PATH entry with a stray quote stops cmd.exe's own search, so npm.cmd is found here.
  const env = { Path: 'C:\\bad"dir;"C:\\Program Files\\nodejs"' };
  const cmd = V.npmCommand(["install", "a b&c"], { platform: "win32", env, node: "C:\\x\\node.exe", exists: (f) => f === "C:\\Program Files\\nodejs\\npm.cmd" });
  assert.deepEqual(cmd, { file: '"C:\\Program Files\\nodejs\\npm.cmd" "install" "a b&c"', args: [], shell: true });
  assert.throws(() => V.cmdQuote("%PATH%"), /cmd\.exe/);
  assert.equal(V.cmdQuote("dir\\"), '"dir\\\\"');

  const e = V.childEnv({ Path: "C:\\Windows" }, winNode, "win32");
  assert.equal(e.Path, "C:\\Program Files\\nodejs;C:\\Windows", "node's folder goes first, under the key Windows uses");
  assert.equal(V.childEnv({ PATH: "/usr/bin" }, nvm, "linux").PATH, "/home/p/.nvm/versions/node/v22.1.0/bin:/usr/bin");
});

test("still and render run the project's own Remotion CLI with node: no npx, no shell", () => {
  const dir = path.resolve("/v/project");
  const pkg = path.join(dir, "node_modules", "@remotion", "cli", "package.json");
  const opts = { node: "node-bin", exists: (f) => f === pkg, read: () => ({ bin: { remotion: "remotion-cli.js" } }) };
  const still = V.remotionCommand(dir, V.stillArgs({ frame: 45, out: "a.png" }), opts);
  assert.deepEqual(still, { file: "node-bin", args: [path.join(path.dirname(pkg), "remotion-cli.js"), "still", "src/index.ts", "Main", "a.png", "--frame=45"], shell: false });
  assert.deepEqual(V.stillArgs({ comp: "Vertical", frame: 0, out: "b.png", scale: "0.5", rest: ["--gl=swangle"] }), ["still", "src/index.ts", "Vertical", "b.png", "--frame=0", "--scale=0.5", "--gl=swangle"]);
  assert.deepEqual(V.renderArgs({ out: "v.mp4" }), ["render", "src/index.ts", "Main", "v.mp4"]);
  assert.throws(() => V.remotionCommand(dir, [], { exists: () => false }), /isn't installed .* video\.mjs install/);
  assert.deepEqual(V.parseFrames("45, 150,300"), [45, 150, 300]);
  for (const bad of [undefined, true, "", "a", "-1", "4.5"]) assert.throws(() => V.parseFrames(bad), /--frame/, String(bad));
  assert.equal(V.stillPath(dir, "Main", 45), path.join(dir, "out", "stills", "Main-0045.png"));
  assert.deepEqual(V.parseArgs(["still", "d", "--frame", "45", "--comp=Main", "--", "--gl=swangle"]), { _: ["still", "d"], flags: { frame: "45", comp: "Main" }, rest: ["--gl=swangle"] });
});

test("the render report reads ffprobe's JSON: duration, size, fps, file size and audio", () => {
  const probe = {
    streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, r_frame_rate: "30/1" }, { codec_type: "audio" }],
    format: { duration: "20.000000" },
  };
  assert.deepEqual(V.summarize(probe, 6_710_886), { bytes: 6_710_886, fileSize: "6.4 MB", duration: 20, width: 1920, height: 1080, fps: 30, codec: "h264", audio: true });
  assert.deepEqual(V.summarize(null, 900), { bytes: 900, fileSize: "900 B", duration: null, width: null, height: null, fps: null, codec: null, audio: false }, "no ffprobe: size only");
  assert.equal(V.humanBytes(1536), "1.5 KB");
  assert.equal(V.humanBytes(3 * 1024 ** 3), "3.0 GB");
});

test("the script answers --self-test, plan and paths from the command line, and exits 1 with a reason", () => {
  const self = run("--self-test");
  assert.equal(self.status, 0, self.stderr);
  assert.match(self.stdout, /^ok\b/m);
  const p = run("plan", "--length", "1:30", "--size", "vertical");
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(JSON.parse(p.stdout).frames, 2700);
  const bad = run("plan", "--size", "1081x720");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^error: H\.264 needs an even width and height/);
  const dir = tmp();
  try {
    const paths = run("paths", "--slug", "demo", "--cwd", dir);
    assert.equal(paths.status, 0, paths.stderr);
    const r = JSON.parse(paths.stdout);
    assert.match(r.root, /demo$/);
    assert.ok(r.video.endsWith(`demo.mp4`));
    const init = run("init", path.join(dir, "p"), "--length", "3s");
    assert.equal(init.status, 0, init.stderr);
    assert.equal(JSON.parse(init.stdout).plan.frames, 90);
    const still = run("still", path.join(dir, "p"), "--frame", "10");
    assert.equal(still.status, 1, "no node_modules: it says to install first");
    assert.match(still.stderr, /isn't installed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(run("nope").status, 1);
});

test("doctor reports node, npm, disk and any Remotion projects as JSON", () => {
  const r = run("doctor", "--dir", tmpdir());
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.equal(d.node.ok, true);
  for (const k of ["npm", "disk", "ffmpeg", "projects", "ok"]) assert.ok(k in d, k);
  assert.ok(Array.isArray(d.projects));
});
