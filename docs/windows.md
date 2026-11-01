# Windows notes

Claude Code on Windows runs commands through Windows PowerShell 5.1 or Git Bash. Both have traps
that look like real failures. These are the ones that cost time while building this collection.

| Trap | What you see | Do this instead |
|---|---|---|
| `Set-Content -Encoding utf8` and `Out-File -Encoding utf8` write a byte-order mark | `JSON.parse` fails on `package.json`; a first line starts with `ï»¿` | Edit files with Claude's Edit or Write tools, or write with Node: `node -e "require('fs').writeFileSync(...)"` |
| `Get-Content` reads UTF-8 without a BOM as the ANSI code page | `→` becomes `â†’` once the file is written back | Same as above; never round-trip a file through `Get-Content` and `Set-Content` |
| A native command's stderr turns into a PowerShell error | `git fetch` succeeds but the tool reports exit code 255 or `NativeCommandError` | Check `$LASTEXITCODE`, or run git from the Bash tool |
| Piping a string to a native command adds a BOM | A hook fed `'{"a":1}' \| node hook.mjs` sees invalid JSON | Test hooks from the Bash tool (`echo '{...}' \| node hook.mjs`). The hooks here strip a BOM anyway |
| The Bash tool's `PATH` may not include Node | `'node' is not recognized` from `npm test` in Bash | Run npm from the PowerShell tool, or use the full path `"/c/Program Files/nodejs/node.exe"` |
| Double quotes inside an argument are dropped on the way to a native program | `git commit -m @'...'@` with a `"` in the text fails with `pathspec '...' did not match` | Put the text in a file and pass the file (`git commit -F msg.txt`, `gh pr create --body-file body.md`) |
| Heredocs (`<<'EOF'`) are Bash-only | PowerShell: `Missing file specification after redirection operator` | Write the script to a file with the Write tool, then run it |
| A junction is a link, so deleting through it deletes the target | `Remove-Item -Recurse <worktree>` wipes another checkout's `node_modules` | `cmd /c rmdir <link>` first. git-guard blocks the unsafe form |

PowerShell 7 (`pwsh`) fixes the first three: it writes UTF-8 without a BOM, reads UTF-8 by
default and leaves native stderr alone. If it is installed, Claude Code can use it instead of 5.1.

## Linked installs

`node scripts/install.mjs --link` links each skill folder with a junction. Hook scripts work
through the junction. `/update` and the session-start doctor (`~/.claude/skills/update/scripts/doctor.mjs`)
probe every hook script through the same path its hook uses, and they report any hook that is
installed but doesn't run.
