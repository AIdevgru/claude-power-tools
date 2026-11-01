# Use case: leaving requests for Claude sessions

Sam is the owner of a repo where two Claude sessions work in worktrees.

1. Sam runs `/request-inbox init` once. A `.claude-inbox/` folder appears in the
   main checkout with a README, a TEMPLATE and a `.gitignore`, so request files
   never show up in `git status`.
2. Before lunch Sam drops two files in it: `2026-10-08-fix-footer.md` and
   `2026-10-09-rotate-keys.md`, the second marked `**Priority:** urgent`.
3. A session starts. The SessionStart hook lists both requests, urgent first,
   even though the session works in a worktree.
4. The session claims the urgent one by moving it to `in-progress/` and
   appending `> Claimed by repo-a1 at <UTC>`. The next listing shows the claim
   and who holds it.
5. It needs a decision, so it moves the file to `needs-owner/`. The listing now
   says it is waiting on the owner, and no session acts on it.
6. In a repo with no inbox folder, the session-start hook prints nothing, so it
   adds no noise. A repo that still uses the older `.ForClaude/` name keeps
   working unchanged.
