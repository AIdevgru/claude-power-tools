# Use case: Impeccable is bundled, pinned and credited

Lee installs the `power-tools-ui` plugin and wants the design skills to work without a second
install. The collection bundles Impeccable, a third-party skill, and leaves it untouched.

1. Lee types `/impeccable critique checkout`. The skill is there, in
   `plugins/power-tools-ui/skills/impeccable/`, with its own name, a trigger description about
   designing, critiquing and polishing a frontend, and its command table.
2. Lee's teammate Sam asks which version this is. `vendor.json` pins the tag `skill-v4.8.0`.
   `vendor.lock.json` records the upstream commit and a checksum for each file. The skill's
   own `version` field says 4.8.0, and `THIRD_PARTY.md` lists the same tag.
3. Lee looks for the terms. The skill folder keeps the upstream `LICENSE` (Apache 2.0) and
   `NOTICE.md`. The four Impeccable subagents sit in the plugin's `agents/` folder.
4. Sam checks that nothing was edited. `vendor.mjs verify` finds no difference from the
   locked upstream copy.
5. Lee runs `/ux-mockup`, `/ui-critique-loop` and `/ui-finalize`. Each one calls Impeccable
   by name, so the vendored skill is the one that runs. (Other tests cover how they call it.)
