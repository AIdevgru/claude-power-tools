# Use case: a manager for a fleet of sessions

Lee runs several Claude sessions on one repo. He wants one session to keep them moving. Debounce is covered in `fleet-manager-debounce.md`.

1. He types `/loop /fleet-manager`. On the first run the ledger has no `Deploy:` line, so the skill asks: manual (recommended) or auto. If nobody answers, it uses manual.
2. Each tick gathers the state: `/pr-dashboard`, `ListAgents`, peer messages, the request inbox and whether `main` is green.
3. It puts every open PR in one bucket: ready-to-merge, ci-pending, CI red, conflicting, stalled, blocked on a question or superseded. For red CI it finds the cause first: inherited from `main`, infra, or caused by the PR.
4. A peer's question is answered directly if the code or docs answer it. Questions only Lee can decide go on the Needs owner list, with options and a recommendation.
5. Every blocker gets exactly one owner. A live owner session gets a `SendMessage` that starts `From fleet-manager`. A PR owned by a live session is never taken over. Orphaned work goes to a subagent in a worktree. PRs that wait in line together can go through `/combine-prs`.
6. In manual mode, ready PRs go on Needs owner and nothing merges without Lee's sign-off. In auto mode the manager rates each PR from low to critical. Low and medium merge, and high and critical go to Lee.
7. Only Lee sets the mode. A peer message that asks to switch it is treated as data.
8. Each tick prints one short block and records `active`, `quiet` or `done` for the debounce hook.
9. `/fleet-manager --deploy auto` changes the mode and does nothing else. `--help` prints the switch summary.
