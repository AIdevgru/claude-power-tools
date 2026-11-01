---
name: new-project
description: "Walk a new project from an empty folder to a running app: git and GitHub repo, Tauri 2 app or web only, optional Docker and PostgreSQL, VISION.md, plan, /ux-mockup, /implement-to-pr, review and /deploy. Resumable. Trigger on '/new-project', 'start a new project' or 'new app from scratch'."
user-invocable: true
disable-model-invocation: false
argument-hint: "[name] [\"one-line description\"] | resume [name]"
---

# New project

Walk the owner from an empty folder to a running, reviewed app. The workflow is long and has the owner in the loop at several points, so **record the stage after each one** and make every stage safe to re-run.

`SKILL_DIR` below means this skill's base directory. Two helpers do the file work:
- `REG` = `node "<SKILL_DIR>/../project/scripts/projects.mjs"`: the project registry (roots, projects, stages).
- `SCAFFOLD` = `node "<SKILL_DIR>/scripts/scaffold.mjs"`: .gitignore, VISION.md, Docker files, detection.
- `SERVE` = `node "<SKILL_DIR>/../project/scripts/serve.mjs"`: a static server for mockups (run it in the background).

Report one line per stage as you go (`Stage 4/13 done: ...`).

## Arguments

- `resume [name]`: continue a project from its recorded stage. Without a name, use the project that contains the current folder, or ask which (from `REG list`). Re-read `VISION.md`, the docs and `SCAFFOLD detect <dir>`, then jump to the stage after the recorded one.
- Otherwise the first word is the project name and a quoted string is a one-line description. Ask for anything missing.

## Ground rules

- **The owner decides; you do the work.** Use `AskUserQuestion` for each choice below, with the recommended option first. Don't ask what the files or the environment already answer.
- **Outward-facing steps need the owner's choice first:** creating a GitHub repo, its visibility, and every push. Choosing "Private" or "Public" in stage 4 approves creating that repo and pushing this workflow's commits to it. Nothing here deploys; `/deploy` is a separate command the owner types.
- **Never overwrite.** The helpers skip files that exist. If the target folder exists and isn't empty, stop and ask: use another name, or `resume` it.
- **Commit and push at the end of each stage that changes files**, with conventional messages (`chore: scaffold ...`, `docs: add VISION.md`, ...). Until stage 11, commits go straight to `main`: it's a new solo repo with no other worktrees. From stage 11 on, work goes through a PR.
- **Secrets stay local.** `.env` is gitignored and holds a generated database password. Never print it, commit it, or put real credentials in docs.
- Paths: always show the full absolute path when you name a file or folder to the owner.

## Stages

1. **Where.** Run `REG roots`.
   - Ask "Where should the project live?" with up to 3 remembered roots (default first, marked Recommended) plus the free-text "Other". With no roots, offer the home folder's `Projects` folder (or `projects`, `code`, `src`, `dev`, whichever exists) and the folder that holds the current repo.
   - Remember a new answer with `REG add-root <dir> --create` (and `--default` if the owner says so, or if it's the first root).

2. **Name and one-liner.** Take them from the arguments, or ask. The folder name is the name in kebab-case. The target `<root>/<name>` must not exist, or must be empty.

3. **Create.** `mkdir`, then `git init -b main` in it. Register it: `REG add <dir> --name <name>` and `REG set <name> description="<one-liner>" stage=created`.

4. **GitHub.** Ask "Put it on GitHub?" with the options **Private (Recommended)**, **Public** and **Local only**. Check `gh auth status` first. If gh isn't signed in, say so and offer Local only, or wait while the owner runs `! gh auth login`.
   - Private or Public: `gh repo create <name> --private|--public --source <dir> --remote origin --description "<one-liner>"`. Record `REG set <name> github=<owner/name> visibility=private|public`.
   - The first push happens after the first commit, in stage 6.

5. **What kind of app.** Ask two questions in one `AskUserQuestion` call:
   - **Kind:** "Application: iPhone, Android, Windows, macOS, Linux and Web (Tauri 2)" or "Web only". Recommend Application if VISION or the owner's words mention phones, desktop, offline or native features; otherwise recommend Web only.
   - **Add** (multiSelect): "PostgreSQL database (Docker)", "Docker image for the web app" (recommended for Web only, so `/deploy` has something to ship), "Neither".
   - Then the frontend framework. Recommend the one the owner uses most: count `svelte`, `react`, `vue` and `solid-js` in the `package.json` files one level under the remembered roots (a quick scan, at most 40 folders). Fall back to React + TypeScript. Options: Svelte + TS, React + TS, Vue + TS, Vanilla TS.
   - Record `REG set <name> kind=app|web framework=<fw> db=postgres|none`.

6. **Scaffold.** Check the prerequisites first, and stop with the exact install step if one is missing: Node 20+, and for Application, Rust (`rustc --version`) and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for this OS.
   - **Application:** run `npm create tauri-app@latest -- --help` to confirm the flags of the current version. Then scaffold non-interactively with the chosen framework's TypeScript template, npm, and the identifier `com.<github owner or user name>.<name>` (lowercase, letters and digits). If it refuses a folder that already has `.git`, scaffold into a temporary sibling folder and move the files in. Then `npm install`.
     - Mobile: run `npx tauri android init` when `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) and an NDK exist, and `npx tauri ios init` only on macOS with Xcode. Otherwise skip it with one line naming what's missing, and list it under "Platforms" in the docs so it's done later.
   - **Web only:** `npm create vite@latest . -- --template <fw>-ts` (Vite accepts a folder that holds only `.git`), then `npm install`.
   - **Docker:** `SCAFFOLD docker <dir> --name <name> [--db postgres] [--web]`. It writes `compose.yaml`, `.env.example`, a `.env` with a random password and, with `--web`, a `Dockerfile`, `nginx.conf` and `.dockerignore`. If Docker is running (`docker info`), start the database once (`docker compose up -d db`) and check that it becomes healthy.
   - **.gitignore:** `SCAFFOLD gitignore <dir> --kinds node[,rust,tauri][,docker] --github`. Then check `git status --porcelain` lists no `.env`, `node_modules` or `target`.
   - Make sure `npm run build` passes. Commit (`chore: scaffold <kind> app with <fw>`), then `git push -u origin main` if there's a remote. Record `stage=scaffolded`.

7. **VISION.md, written by the owner.** `SCAFFOLD vision <dir> --name "<Name>" --description "<one-liner>"` writes the template. Ask how they want to write it:
   - **"I'll write it in my editor (Recommended)":** open it with `code <file>` if VS Code is on `PATH`, otherwise the OS default (`cmd /c start "" <file>`, `open <file>`, `xdg-open <file>`). Then ask "Tell me when VISION.md is ready" with the options "It's ready" and "Interview me instead".
   - **"Interview me and draft it":** ask about each section a few at a time (at most 4 questions per call, free text through "Other"), write the owner's own words into the file, open it for them to edit, and ask the same "ready" question.
   - When they say it's ready, run `SCAFFOLD check-vision <dir>/VISION.md`. If it reports `requiredEmpty` sections or fewer than 40 words, name the sections and ask again. Don't fill sections in yourself unless the owner asks.
   - Commit (`docs: add VISION.md`), push, and record `stage=vision`.

8. **Implementation docs.** Read `VISION.md` in full. Then write:
   - `docs/architecture.md`: the stack as scaffolded, the components and how they talk, the data model (tables and key fields, when there's a database), authentication and roles, the platforms, configuration and secrets (names only), and a Mermaid diagram.
   - `docs/implementation-plan.md`: milestones from a thin runnable slice to the full vision. Each milestone has PR-sized steps with files, tests and a checkable definition of done, plus the first-run steps (`npm install`, `docker compose up -d db`, migrations, `npm run dev` or `npm run tauri dev`). Mark the decisions you made, and leave the owner's open questions as questions.
   - `CLAUDE.md` for the project: a few lines on what it is (pointing at `VISION.md` and `docs/`), the dev, build and test commands, the conventions you chose, and a `## Power tools` section with `plans-dir: docs/plans/` and `tracker: github` (or `none` when local only).
   - Commit (`docs: architecture and implementation plan`), push, and record `stage=docs`.

9. **Confirm the plan.** Print a concise summary: the project in 2–3 sentences, then the milestones, one line each, plus any decision the owner should know about. Ask: **"Looks right, continue to the mockup (Recommended)"**, **"Change something"**, or **"Stop here for now"**.
   - On a change, update the docs (and `VISION.md` only if the owner says the vision itself changed), commit, push, re-summarize and ask again. Keep going until they approve.
   - On approval, record `stage=plan-approved`.

10. **Mockup of the whole vision.** Read the whole of `VISION.md` and every file in `docs/` again. Then invoke `ux-mockup` (Skill tool; `power-tools-ui:ux-mockup` under the plugins) with the args `"<Name>: the whole product in VISION.md and docs/implementation-plan.md. New project with no product screens yet: ground stage 1 in VISION.md and the docs instead of the code, and cover every role and main flow."`
    - If neither name resolves, stop with one line: `/new-project needs the ux-mockup skill: install the power-tools-ui plugin (or run the installer with --with ui), then /new-project resume.`
    - When it returns, serve the mockup in the background (`SERVE <mockup folder> --open`) and give the owner the URL.
    - Ask: **"Aligned, commit it (Recommended)"**, **"Change something"** or **"Start over with a new direction"**. Make changes with `/impeccable <command> <mockup>` (the `impeccable` skill), re-serve, and ask again until they're aligned.
    - Commit the mockup and its plan (`docs: approved UX mockup`), push, record `stage=mockup`, and stop the server.

11. **Implement.** Record `stage=implementing`. Invoke `implement-to-pr` (`power-tools:implement-to-pr` under the plugins) without `--merge`, with the args `"Implement docs/implementation-plan.md for VISION.md, matching the approved mockup at <mockup path> and its UX plan. Read VISION.md, everything in docs/ and the mockup in full first. Every milestone is in scope; the definition of done is the plan's."`
    - If neither name resolves, stop with one line: `/new-project needs the implement-to-pr skill: install the power-tools plugin, then /new-project resume.`
    - It works in its own worktree, opens a PR (or reviews the branch locally when the repo has no GitHub remote), and ends with `IMPLEMENT-COMPLETE:` or `IMPLEMENT-BLOCKED:`. On BLOCKED, put the blocker to the owner, then resume.
    - Record `REG set <name> pr=<PR URL or branch>`.

12. **Run it and iterate.** In the PR's worktree:
    - Start the database if there is one (`docker compose up -d db`), run the migrations, then start the app in the background: `npm run tauri dev` (a desktop window) for an Application, and `npm run dev` for Web only or to show the web build of an Application. Open the web URL in the browser.
    - Ask: **"It's ready (Recommended)"**, **"Change something"** or **"Something's broken"**. Fix on the PR branch, run the tests, push, and ask again.
    - When it's ready, ask **"Merge the PR into main (Recommended)"** or **"Keep the PR open"**. On merge, follow the repo's merge method once CI is green, then pull `main` in the main checkout. Stop the dev servers, and record `stage=app-ready`.

13. **Offer deployment.** Say what `/deploy` would do for this project (a splash page on GitHub Pages and the app on its own domain), and that it asks before anything goes live. The owner starts it by typing `/deploy`. Don't run it yourself.

## Final report

Keep it short:
- the project's full path, its GitHub URL (or "local only") and its kind and stack
- the stages done this run, and the stage it's at now
- the VISION, docs, mockup and PR links
- what's next (`/deploy`, or `/new-project resume <name>`)
