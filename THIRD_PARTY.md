# Third-party software

These skills are bundled unmodified from their upstream projects, under their own licenses.
They are not covered by this repository's [Apache-2.0 license](LICENSE). Each one keeps its
upstream LICENSE and NOTICE inside its folder. `vendor.json` says where each file comes from,
and `vendor.lock.json` pins the upstream commit and a sha256 of every file.

| Package | Upstream | Version | License | Shipped as |
|---|---|---|---|---|
| Impeccable (by Paul Bakaus) | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | `skill-v4.8.0` (`414603bf14c7`) | Apache-2.0 ([LICENSE](plugins/power-tools-ui/skills/impeccable/LICENSE), [NOTICE](plugins/power-tools-ui/skills/impeccable/NOTICE.md)) | in the `power-tools-ui` plugin: `plugins/power-tools-ui/skills/impeccable/`, `plugins/power-tools-ui/agents/impeccable-*.md` |
| graphify (by Safi Shamsi and contributors) | [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) | `v0.9.97` (`0a8cd4e1e342`) | Apache-2.0; earlier portions MIT ([LICENSE](extras/graphify/LICENSE), [LICENSE-MIT](extras/graphify/LICENSE-MIT), [NOTICE](extras/graphify/NOTICE)) | `extras/graphify/`, installer only (`--with graphify`); in no plugin |

Impeccable's NOTICE also credits ehmo's
[platform-design-skills](https://github.com/ehmo/platform-design-skills) (MIT) for its iOS and
Android references.

## What is and isn't included

- **Impeccable:** the skill folder (`SKILL.md`, `reference/`, `scripts/`) and its four
  subagents. Its `scripts/impeccable` launcher downloads a native engine on first use and
  checks it against `scripts/engine-checksums.txt`; that engine is not stored here.
  Impeccable's own plugin hooks are **not** registered by `power-tools-ui`: its design-detector
  hook is opt-in per project, and `/impeccable hooks on` installs it into that project's
  `.claude/settings.local.json`.
- **graphify:** the Claude Code skill (the Bash variant from `graphify/skill.md`) and its
  `references/`. The skill drives the `graphify` command from the
  [`graphifyy`](https://pypi.org/project/graphifyy/) Python package, which is not bundled:
  install it with `uv tool install graphifyy` or `pipx install graphifyy`. On Windows,
  `graphify install` can replace the skill with upstream's PowerShell variant.

## Updating

```sh
node scripts/vendor.mjs sync graphify --ref v0.9.97   # new upstream tag
node scripts/vendor.mjs verify                        # also part of npm test
```

Don't edit vendored files by hand. Send fixes upstream, or wrap the behavior in one of
this repo's own skills.
