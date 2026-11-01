---
description: "Plain phrasing should pick the ticket-to-pr skill."
tags: [trigger]
runs: 2
max_turns: 4
allowed_tools: [Skill]
append_system_prompt: "This is a skill-selection test in an empty folder. If one of your skills fits the request, invoke it with the Skill tool, then stop and name the skill you used without doing the work. If none fits, answer briefly."
---

Take Jira ticket ABC-31 from start to a reviewed PR, and keep the ticket's status up to date as you go.
