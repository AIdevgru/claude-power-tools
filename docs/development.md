# Development

| Command | What it does |
|---|---|
| `npm test` | Runs every test suite and repo check. CI runs it on Linux and Windows. |
| `npm run eval` | Runs each plugin's trigger evals (`plugins/<plugin>/evals/triggers/`) with `claude plugin eval`. |
| `npm run sync-shared` | Copies shared files from their source skill to the others. |
| `npm run vendor:verify` | Checks that bundled third-party files still match upstream. |

## Where things live

```text
.claude-plugin/marketplace.json     the aidevgru marketplace: three plugins, plus the rename
                                    of the old claude-power-tools plugin to power-tools
plugins/<plugin>/
  .claude-plugin/plugin.json        name, version (= package.json), description
  skills/<skill>/SKILL.md           the plugin's skills
  agents/                           subagents (power-tools-ui only: Impeccable's)
  hooks/hooks.json                  the plugin's hooks, as ${CLAUDE_PLUGIN_ROOT}/skills/<skill>/...
  evals/triggers/<case>/            trigger evals for the plugin's skills
extras/graphify/                    installer-only skill (--with graphify); in no plugin
scripts/layout.mjs                  which folder holds which skill
scripts/install.mjs, sync-shared.mjs, vendor.mjs, eval.mjs
tests/                              repo checks and use-case stories with their tests
```

The plugins are `power-tools` (fleet, PR and delivery skills, git-guard, `/update`),
`power-tools-ui` (UX mockups, the UI critique loop, the finish pass, Impeccable) and
`power-tools-projects` (new project to deploy, the project registry).

`scripts/layout.mjs` is the only place that maps a skill to its folder. Its `PLUGINS` names each
plugin folder and its installer group, and `EXTRAS` names installer-only skills; which skills a
plugin ships comes from its `skills/` folder. The installer, `sync-shared.mjs`, `vendor.mjs` and
the tests use its helpers (`skillDirs()`, `skillDir(name)`, `skillFile(name, ...)`,
`pluginOf(name)`, `skillsInGroups(groups)`) instead of hard-coding paths. To add a skill, create
`plugins/<plugin>/skills/<name>/SKILL.md`; to add a plugin, add its folder, a `PLUGINS` entry and
a marketplace entry.

Each plugin is copied into Claude Code's plugin cache on its own, so:

- A file in a plugin never refers outside its plugin folder with `../`. A skill may use another
  skill's scripts in the same plugin (`<SKILL_DIR>/../project/scripts/...`).
- A skill calls a skill in another plugin only by its Skill name, with the owning plugin's prefix
  (`power-tools-ui:impeccable`), and says which plugin to install when it isn't there.
- `scripts/` and `tests/` aren't part of any plugin, so nothing inside a plugin imports them.
  `/update`'s scripts read a downloaded copy of the repo in either layout on their own.

`npm test` checks all of this (`tests/use-cases/plugin-packaging.md`).

## Tests

`npm test` covers:

- the installer, the updater and the hook doctor
- git-guard, the project registry and scaffolding, the inbox script and the debounce logic
- the pr-dashboard Python suite, over sanitized fixtures
- the vendored-file check
- the plugin layout: one plugin per skill, hooks and `../` paths inside their plugin, plugin
  prefixes that match, and graphify in no plugin
- repo-wide checks: skill frontmatter, links, matching use-case stories and tests, references to
  renamed skills, shared files in sync, eval cases that name real skills of their own plugin,
  `/impeccable` commands that exist in the bundled copy, and a scan for private names and paths

Each scripted feature has a story in `tests/use-cases/<name>.md` and a test in
`tests/use-cases/<name>.md.test.mjs`.

## Trigger evals

`npm run eval` checks that plainly worded requests pick the right skill, and that one general
question picks none. `claude plugin eval` loads one plugin at a time, so each case lives in the
plugin that ships its skill, and `scripts/eval.mjs` runs
`claude plugin eval plugins/<plugin> --tag trigger --ablation none` for each plugin. Name plugins
to run only those, and pass extra options after `--`:

```sh
npm run eval -- power-tools-ui -- --case ux-mockup
```

It costs model calls, so it isn't part of `npm test`. Run it after changing a skill's description.

## Versions

`package.json` holds the version. Each plugin's `plugin.json` repeats it, and `npm test` fails when
they differ, so bump them together. `marketplace.json` has no version.

## Shared files

An installed skill can read only its own folder, so some files are copied into several skills.
Edit the copy in the skill named in `scripts/sync-shared.mjs`, then run `npm run sync-shared`.
`npm test` fails while a copy differs.

## Bundled skills

To update a bundled third-party skill, run `node scripts/vendor.mjs sync <name> --ref <tag>` and
commit the result. `vendor.json` maps each upstream file to its place here: Impeccable into the
`power-tools-ui` plugin, graphify into `extras/`. See [THIRD_PARTY.md](../THIRD_PARTY.md).
