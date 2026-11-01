---
description: "Plain phrasing should pick the usage-handoff skill."
tags: [trigger]
runs: 2
max_turns: 4
allowed_tools: [Skill]
append_system_prompt: "This is a skill-selection test in an empty folder. If one of your skills fits the request, invoke it with the Skill tool, then stop and name the skill you used without doing the work. If none fits, answer briefly."
---

Keep an eye on my Claude usage. Before we hit the limit, get every session to write down where it is, and pick the work back up when the limit resets.
