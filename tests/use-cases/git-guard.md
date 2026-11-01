# Use case: git-guard stops the commands that lose parallel work

Sam runs three Claude sessions on one repo. Two of them once lost work to each
other: one stashed the other's edits in the main checkout and switched branches
under it. Sam installs the power tools, which register git-guard.

1. A session tries `git commit --no-verify` to get past a failing lint hook. The
   hook denies it and tells the session to fix what the lint hook reports.
   `commit -n` and `-c core.hooksPath=...` are caught the same way.
2. A session tries `git push --force` on its branch. It is told to use
   `--force-with-lease`, which goes through. Rewriting or deleting `main` on the
   remote is refused even with a lease.
3. The repo now has worktrees, so `main` is shared. A session that tries to
   commit on `main` is denied, with the `git worktree add` command for its own
   branch in the reason. Sam's solo side project has no other worktrees, so
   committing on `main` there is fine.
4. Session A edits `README.md` in the main checkout with the Edit tool. Session B
   then tries `git checkout -b fix/footer` in the same checkout. B is denied: the
   main checkout has a dirty file B didn't write, and the reason names it and
   gives the worktree command. A itself is allowed, because the ledger shows it
   wrote that file. `git stash list` is always fine, and so is any command run
   from inside a linked worktree.
5. A session cleaning up runs `rm -rf ../repo-feature` on a worktree whose
   `node_modules` is a junction into the main checkout. It is denied and told to
   unlink the junction first with `cmd /c rmdir`. `Remove-Item -Recurse` and
   `git worktree remove` are caught the same way.
6. Sam really does want to commit on `main` in one repo, so Sam runs
   `/git-guard allow commit-on-main`, which writes `.claude/git-guard.json`.
   That rule is off for that repo only.
7. If the hook gets input it can't read, it prints nothing and the command runs.
   Input that starts with a byte-order mark (Windows PowerShell 5.1 adds one when
   it pipes text) is read normally, so the rules still apply.
8. Sam is tired of typing merge commands by hand, so Sam runs
   `/git-guard enable merge-gate` and adds a permission rule for `gh pr merge`.
   A session that tries `gh pr merge 12` is denied: Sam hasn't approved #12. The
   reason tells the session to ask for `approve merge #12`.
9. Sam writes "approve merge #12" as the first line of a message. The
   UserPromptSubmit hook records it in the session ledger, tied to this repo and
   to #12's current head commit. The merge is still denied while a check on #12
   is running, red or stale, and when no checks ran at all. Once every check is
   green it goes through. Approving #12 doesn't approve #14, and it doesn't
   approve #12 in another repo.
10. Only a first line that is nothing but the approval counts. "don't approve
    merge #12 yet", "should I approve merge #12?" and an approval pasted further
    down a message approve nothing.
11. A session pushes a new commit to #12 after Sam approved it. The merge is
    denied until Sam approves again, because Sam approved the code Sam saw.
12. #14 has one red check from an upstream CVE that Sam judges unrelated. Sam
    writes "approve merge #14 anyway", and that merge goes through despite the
    red check. `--admin` is refused whatever Sam approved, and so is a merge
    that names a branch instead of a number.
13. With the gate off, which is the default, `gh pr merge` is left alone. Once
    Sam enables it in the global config, a repo's own `.claude/git-guard.json`
    can't switch it off with `allow`; only Sam's global config can.
