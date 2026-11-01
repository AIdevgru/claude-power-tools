---
name: deploy
description: "Deploy a project: a splash page on GitHub Pages, and the app on its own domain (Cloudflare Pages, Fly.io, or Tauri installers on GitHub Releases) through GitHub Actions. Confirms the plan before anything goes live and never handles secrets. Explicit invocation only: '/deploy'."
user-invocable: true
disable-model-invocation: true
argument-hint: "[--splash-only | --app-only] [--domain app.example.com] [--splash-domain example.com]"
---

# Deploy

Put the project in the current repo online: a **splash page** on GitHub Pages and the **app** on its own domain. Everything deploys through GitHub Actions workflows committed to the repo, so later deploys happen on push and nobody deploys by hand.

`SKILL_DIR` below means this skill's base directory. Helpers:
- `REG` = `node "<SKILL_DIR>/../project/scripts/projects.mjs"`
- `DETECT` = `node "<SKILL_DIR>/../new-project/scripts/scaffold.mjs" detect <repo>`
- `SERVE` = `node "<SKILL_DIR>/../project/scripts/serve.mjs"`
- Workflow templates in [templates/workflows/](templates/workflows/pages.yml).

Report one line per stage (`Stage 3/8 done: ...`).

## Ground rules

- **This is outward-facing.** The owner typing `/deploy` starts the work, but nothing goes live until they approve the plan in stage 3. Re-confirm if the plan changes after that.
- **Secrets never pass through you.** When a workflow needs a token, give the owner the exact command to run themselves, `! gh secret set <NAME>` (it prompts for the value), and where to create the token. Never ask for a token in chat, echo one, or write one to a file.
- **DNS is the owner's.** Print the exact records to add. Change DNS only through a provider CLI the owner has already signed in to, and only after they approve those records.
- **Repo rules win.** If the repo uses PRs for `main`, the workflows go in through a PR. Never use `--no-verify`, force-push, or deploy from your machine (no `wrangler pages deploy` or `flyctl deploy` run locally). The workflows do the deploying.
- **Pin actions.** Before committing a workflow, check the latest major of each action it uses (`gh api repos/<owner>/<action>/releases/latest --jq .tag_name`) and update the template's pin if a newer major exists.

## Stages

1. **Read the project.** Run `DETECT` and `REG get <name> --json`. If the repo isn't registered, register it with `REG add <repo>`. Read `VISION.md` and `docs/` for the name, the one-liner, the audience and the platforms. Check:
   - There's a GitHub remote (`gh repo view --json nameWithOwner,visibility,defaultBranchRef`). Without one, stop: deployment runs on GitHub Actions. Offer to create the repo as in `/new-project` stage 4.
   - `main` is clean and green: `git status`, then `gh run list --branch main --limit 1`.
   - The app builds locally (`npm run build`).

2. **Choose the targets.** Ask in one `AskUserQuestion` call:
   - **App host**, recommended by what `DETECT` found:
     - static web app, no server or database → **Cloudflare Pages (Recommended)**, Netlify or Vercel
     - server or database (`db: postgres`, or a backend in the docs) → **Fly.io (Recommended)** (the Docker image plus Fly Postgres) or "My own server or Kubernetes" (you prepare the image build and manifests, and the owner runs the cluster)
     - Tauri app → also offer **Desktop installers on GitHub Releases** (`tauri-release.yml`); mobile store releases are listed as manual next steps
   - **App domain**: `--domain`, or free text through "Other", or "Use the host's default domain for now".
   - **Splash domain**: `--splash-domain`, or "Use <owner>.github.io/<repo>".

   GitHub Pages on a **private** repo needs a paid GitHub plan. If the repo is private, check `gh api user --jq .plan.name`. On the free plan, ask: **"Publish the splash page from a separate public repo <name>-site (Recommended)"**, "Make this repo public" or "Skip the splash page".

3. **Approve the plan.** Print what will happen, in order: the files to add, the repo settings to change (enable Pages, create a site repo), the secrets the owner must set, the DNS records, and the URLs it will end at. Ask: **"Go ahead (Recommended)"**, "Change something" or "Cancel". Nothing outward-facing happens before "Go ahead".

4. **Splash page** (skipped with `--app-only`). Build it like `/ux-mockup`, but as a public page. It needs the `impeccable` skill (`power-tools-ui:impeccable` under the plugins); if neither name resolves, skip this stage and stage 5 with one line: `Splash page skipped: it needs the power-tools-ui plugin (or the installer's --with ui).`
   - Run `/impeccable shape` (the `impeccable` skill via the Skill tool) for a landing page that sells the product in `VISION.md` to its audience: the promise, three to five benefits, screenshots or mockup frames from `docs/design/`, a primary call to action (open the app, or download for each platform) and a short footer. Accept its recommended options and log them.
   - Build `site/index.html` as one self-contained page (inline CSS and JS, pinned CDN versions only), with a title, a meta description, Open Graph and Twitter tags, a favicon, a phone-width layout, a dark mode and no tracking. Images go in `site/assets/`.
   - Run `/impeccable layout`, `harden` and `overdrive` on it (a landing page may be bolder than product UI), then `ui-critique-loop --score 36 <served URL>` (`power-tools-ui:ui-critique-loop` under the plugins).
   - Serve it (`SERVE site --open`), show the owner, and iterate until they approve: **"Publish this (Recommended)"** or **"Change something"**. Stop the server.
   - Add `site/CNAME` when there's a splash domain, and a `.nojekyll` file.

5. **Splash workflow.** Copy `templates/workflows/pages.yml` to `.github/workflows/pages.yml` (in the site repo, if you made one in stage 2). Enable Pages for Actions builds: `gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow`, or `-X PUT` if Pages already exists. With a custom domain, print the DNS records: four `A` records to `185.199.108.153`, `185.199.109.153`, `185.199.110.153` and `185.199.111.153` for an apex domain, or a `CNAME` to `<owner>.github.io` for a subdomain. Then set the domain with `gh api -X PUT repos/<owner>/<repo>/pages -f cname=<domain>`.

6. **App workflow** (skipped with `--splash-only`). Copy the matching template to `.github/workflows/` and fill in its `{{placeholders}}`:
   - **Cloudflare Pages** (`cloudflare-pages.yml`): `{{build_dir}}` from the build output (usually `dist`) and `{{project}}` as the repo name. Secrets: `CLOUDFLARE_API_TOKEN` (a token with Cloudflare Pages: Edit) and `CLOUDFLARE_ACCOUNT_ID`. The Pages project is created on the first deploy. The custom domain is added in the Cloudflare dashboard (Pages → the project → Custom domains), which creates the DNS record when the zone is on Cloudflare.
   - **Fly.io** (`fly.yml`): needs `fly.toml`. If `flyctl` is installed and signed in, the owner runs `! fly launch --no-deploy` (it asks about the region and Postgres). Otherwise write a minimal `fly.toml` with `internal_port` set to the image's port, and list `fly postgres create` and `fly postgres attach` as owner steps. Secret: `FLY_API_TOKEN` (from `fly tokens create deploy`). Domain: `fly certs add <domain>`, then the records it prints.
   - **Netlify or Vercel:** no template. Prefer their Git integration (the owner connects the repo in the dashboard). Give the build command, the output folder and the domain steps.
   - **Own server or Kubernetes:** add a workflow that builds the Docker image and pushes it to GHCR (`ghcr.io/<owner>/<repo>`), plus a `deploy/` folder with a compose file or Kubernetes manifests that reference the image. Applying them on the server is the owner's step.
   - **Desktop installers** (`tauri-release.yml`): fill in `{{name}}`. A release is cut by pushing a `v*` tag. Explain the optional signing secrets and don't create a tag unless the owner asks for one.
   - When the app needs runtime settings, list each variable (the name and where to set it, such as `fly secrets set`), never a value.

7. **Ship it.** Commit the site and workflows (`ci: deploy splash page and app`) and push, through a PR if the repo uses them. Once the owner confirms the secrets are set (`gh secret list` shows the names), trigger the workflows (`gh workflow run <file>` for `workflow_dispatch`, or let the push trigger them) and follow them with `gh run watch <id>`. Diagnose failures from `gh run view <id> --log-failed` and fix them in the repo; never work around a failure by deploying by hand.

8. **Verify and record.** Fetch each URL (`curl -sSI`, then the page title). Report what isn't live yet, such as DNS still propagating or a certificate still pending, with what to check later. Record `REG set <name> stage=deployed url.splash=<url> url.app=<url>` (and `url.releases=` for a desktop release).

## Final report

- the splash and app URLs, live or pending (and why)
- the workflows added, and what triggers each
- the secrets and DNS records the owner set or still has to set
- the manual next steps (store listings, code signing, backups) and anything that failed
