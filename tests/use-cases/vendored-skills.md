# Use case: shipping third-party skills unmodified

The UI skills (`ux-mockup`, `ui-critique-loop`, `ui-finalize`, and the delivery pipelines' UI gate) lean on
Impeccable, and anyone asking about a codebase benefits from graphify. Both are
Apache-2.0, so the collection bundles them instead of sending people off to
install them separately.

1. Sam, a maintainer, reads `vendor.json`. It names each package's upstream repo,
   the tag to ship (`skill-v4.8.0`, `v0.9.96`) and which upstream file or folder
   lands where: Impeccable's skill folder, its LICENSE and NOTICE, and its four
   subagents, all inside the `power-tools-ui` plugin (`plugins/power-tools-ui/`);
   graphify's Claude skill, its references and its licenses in `extras/graphify/`,
   which no plugin ships. A destination outside every plugin's `skills/` and
   `agents/` folders and outside `extras/` fails `vendor.mjs verify`, so a vendored
   file can't land where no install picks it up.
2. Upstream tags a new graphify release. Sam runs
   `node scripts/vendor.mjs sync graphify --ref v0.9.97`. The script makes a
   shallow sparse clone, replaces the vendored files (removing any the new
   release dropped), writes `.graphify_version` from the tag, bumps the ref in
   `vendor.json`, and records the upstream commit and a sha256 per file in
   `vendor.lock.json`.
3. A contributor "fixes a typo" inside
   `plugins/power-tools-ui/skills/impeccable/reference/polish.md`.
   `npm test` fails: the file no longer matches the upstream copy in the lock.
   Adding a new file inside a vendored folder fails the same way, and so does
   deleting one. Local changes belong upstream, or in our own skills.
4. Every vendored package keeps its upstream LICENSE (and NOTICE) inside its
   folder, so an installed copy still carries its terms. `THIRD_PARTY.md` lists
   what is bundled, from where, and under which license.
5. Windows checkouts keep Impeccable's `.cmd` launcher in CRLF, because cmd.exe
   breaks on LF-only batch files; everything else stays LF, so the hashes hold
   on every OS.
