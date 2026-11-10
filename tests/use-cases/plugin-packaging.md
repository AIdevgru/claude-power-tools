# Use case: three plugins from one marketplace

Dana runs four Claude Code sessions on her team's repo. She wants the fleet skills, but
not the UI or new-project skills competing for room in every session's skill listing.

1. She adds the marketplace once: `claude plugin marketplace add aidevgru/claude-power-tools`.
   It lists three plugins: `power-tools` (the fleet, PR and delivery skills plus
   git-guard), `power-tools-ui` (UX mockups, the UI critique loop, the finish pass,
   Remotion videos and the bundled Impeccable with its four subagents) and
   `power-tools-projects` (new project to deploy, and the project registry).
2. She installs only `power-tools@aidevgru`. `/hooks` shows the git-guard hooks, the
   `/fleet-manager` debounce, the usage-handoff check and the request-inbox and doctor
   session-start checks, and
   nothing from the other two plugins: each plugin has its own `hooks/hooks.json`, and
   every hook runs a script inside its own plugin folder.
3. Every skill lives in exactly one plugin, so each one has exactly one name:
   `/power-tools:implement-to-pr`, `/power-tools-ui:ui-critique-loop`,
   `/power-tools-projects:new-project`. `scripts/layout.mjs` is the one place that says
   which folder holds which skill, and the installer, the shared-file sync, the vendor
   check and the tests all read it.
4. A plugin is copied into Claude Code's plugin cache on its own, so no file in one
   plugin reaches into another with `../`. Skills in one plugin may use each other's
   scripts (`/new-project` runs the project registry's script); a skill in another
   plugin is only ever called by its Skill name.
5. Her `/implement-to-pr` run touches a settings page. The UI gate needs
   `power-tools-ui:impeccable`, which she doesn't have, so the gate is skipped with one
   line saying to install the `power-tools-ui` plugin. The same goes for `/new-project`
   reaching its mockup stage and `/deploy` reaching its splash page. Every
   `<plugin>:<skill>` name a skill mentions is the plugin that really ships that skill.
6. Her teammate installed the old single plugin, `claude-power-tools`. The marketplace
   renames it to `power-tools`, so his enabled setting carries over; `/update` tells him
   the two other plugins to install if he wants them.
7. graphify is in no plugin. It claims every codebase question, so it lives in
   `extras/graphify/` and only the installer adds it (`--with graphify`).
8. A maintainer runs `npm run eval`, which runs `claude plugin eval` once per plugin, on
   that plugin's folder. On Windows it starts `claude.exe` directly, or `claude.cmd` as
   one quoted command line, so an option with a space in it reaches `claude` whole.
