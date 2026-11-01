# Use case: from an idea to a running app

Lee has an idea for a habit tracker that should work on a phone and a laptop.

1. Lee types `/new-project habit-tracker "Build habits with friends"`. Claude
   offers the remembered projects folder as the place for it, creates
   `habit-tracker`, runs `git init -b main`, and registers it.
2. Asked about GitHub, Lee picks **Private**, the recommended option. Claude
   creates the private repo with `gh repo create` and wires it up as `origin`.
3. Lee picks **Application** (Tauri 2: iPhone, Android, Windows, macOS, Linux and
   Web), adds a **PostgreSQL database**, and takes the recommended framework,
   the one Lee uses most in other projects.
4. Claude checks Node and Rust, scaffolds the Tauri app, and writes
   `compose.yaml`, `.env.example` and a `.env` with a random database password.
   The database starts healthy. The `.gitignore` covers Node, Rust, Tauri and
   Docker, and `.env` never shows up in `git status`. Android is skipped with a
   note, because this laptop has no Android SDK. The scaffold builds, is
   committed and is pushed.
5. Claude writes a `VISION.md` template and opens it in Lee's editor. Lee
   fills in a few sections and says it's ready, but "What success looks like" is
   still empty, so Claude names that section and waits. Lee finishes it, and it
   is committed.
6. Claude writes `docs/architecture.md`, `docs/implementation-plan.md` and a
   project `CLAUDE.md`, then sums the project and its milestones up in a few
   lines. Lee asks for offline sync to move to a later milestone. Claude
   updates the plan and asks again, and Lee approves.
7. `/ux-mockup` designs the whole product from the vision and the plan. Claude
   serves the mockup and opens it in the browser, makes the two changes Lee
   asks for, and commits it once they agree.
8. `/implement-to-pr` builds the plan in a worktree and opens a reviewed PR.
   Claude starts the database and `npm run tauri dev`, Lee tries the app, one
   fix goes onto the PR, and Lee merges it.
9. Claude explains what `/deploy` would do. Lee closes the laptop instead. The
   next morning a session in the folder says the project is at "app-ready" and
   that `/deploy` is next, and `/new-project resume` picks up from there.
