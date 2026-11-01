---
name: ticket-triage
description: "Triage new tracker tickets (Jira or GitHub Issues): analyze each against the codebase (location, size, risk, overlap), post the analysis, label it triaged, and offer act-or-skip, handing picks to /ticket-to-pr. Never edits code. Trigger on '/ticket-triage', 'check Jira' or 'triage the tickets'."
user-invocable: true
disable-model-invocation: false
argument-hint: "[ticket keys to triage] (default: every untriaged ticket)"
---

# Ticket triage

If the repo's `AGENTS.md` or `CLAUDE.md` has its own triage procedure, that is the source of truth: read it first, and treat this skill as the runnable checklist.

## Tracker settings

Read the `## Power tools` section of the repo's `CLAUDE.md` or `AGENTS.md`:
- `tracker: jira` with `jira-cloud-id`, `jira-project` (the key, e.g. `ABC`), and optionally `triaged-label` (default `triaged`). If the cloud ID is missing, call `getAccessibleAtlassianResources` once and use the site whose URL the repo names. Load the Atlassian tools with ToolSearch if they are deferred.
- `tracker: github`, or no tracker set: GitHub Issues in this repo through `gh`.

Never triage another project by mistake: if the project key isn't configured and can't be found in the repo's docs, ask once.

## Steps

1. **Find new tickets** (or use the keys in `$ARGUMENTS`):
   - Jira: `searchJiraIssuesUsingJql` with `project = <KEY> AND status = "To Do" AND (labels IS EMPTY OR labels not in (<triaged-label>)) ORDER BY created ASC`.
   - GitHub: `gh issue list --state open --search "-label:<triaged-label> sort:created-asc" --json number,title,labels,createdAt,author`.
2. If none come back, reply with one line ("No new tickets.") and stop. Don't ask anything.
3. **Analyze each ticket.** Read it in full (`getJiraIssue` with view `evidence`, or `gh issue view <n> --comments`), then look at the code it touches with Grep/Read, or with an `Explore` agent per ticket when there are several. Check overlap with in-flight work: open PRs (`gh pr list --state open`) and tickets already In Progress.
4. **Write the analysis** per ticket:
   - **Summary:** what is asked, in a sentence or two.
   - **Analysis:** where it lands (`path:line`), size S/M/L, risk, overlap, open questions.
   - **Recommendation:** `take`, `take after <key>`, `needs clarification: <question>`, or `decline: <reason>`.
5. **Record it on the ticket:** post the analysis as a comment (`addOrEditJiraIssueComment`, or `gh issue comment`), and add the triaged label while keeping the existing labels (`editJiraIssue`, or `gh issue edit --add-label`).
6. **Ask the owner.** Show the analyses, then ask with `AskUserQuestion` (`multiSelect: true`), one option per ticket labelled `act <key>`, with the recommendation in the description. Split into several questions of at most 4 options when there are more tickets. A ticket left unselected is a skip.
7. **Act on the picks.** For each selected ticket, run the `ticket-to-pr` skill on it. When there's more than one, run them as parallel background agents and bring each result back for its own merge-or-hold choice.

Triage never edits code and never moves a ticket out of To Do.
