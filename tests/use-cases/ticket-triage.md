# Use case: triaging new tickets

Lee comes back from a weekend to five new tickets. He wants each one analyzed, and he wants to pick which to build.

1. He types `/ticket-triage`. He can also name keys, such as `/ticket-triage ABC-12`.
2. The skill reads the repo's `CLAUDE.md` for the tracker (Jira with a project key, or GitHub Issues) and the triaged label, which is `triaged` by default. If it can't find the Jira project key, it asks once instead of triaging the wrong project.
3. It finds tickets that are still To Do and don't have the triaged label, oldest first. If there are none, it replies "No new tickets." and stops.
4. For each ticket it reads the full text and the code it touches. It checks open PRs and In Progress tickets for overlap.
5. It writes a summary, an analysis (where it lands, size S/M/L, risk, overlap, open questions) and a recommendation: `take`, `take after <key>`, `needs clarification`, or `decline`.
6. It posts that analysis as a comment on the ticket and adds the triaged label, keeping the existing labels.
7. It shows Lee the analyses and asks him with a multi-select, one `act <key>` option per ticket. Over four tickets, it splits them into several questions. Anything he leaves unselected is skipped.
8. For each pick, it runs `ticket-to-pr`. Several picks run as parallel background agents, and each result comes back for its own merge-or-hold choice.
9. Triage never edits code and never moves a ticket out of To Do.
