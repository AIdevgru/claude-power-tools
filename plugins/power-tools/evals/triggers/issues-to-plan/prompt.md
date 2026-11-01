---
description: "Plain phrasing should pick the issues-to-plan skill."
tags: [trigger]
runs: 2
max_turns: 4
allowed_tools: [Skill]
append_system_prompt: "This is a skill-selection test in an empty folder. If one of your skills fits the request, invoke it with the Skill tool, then stop and name the skill you used without doing the work. If none fits, answer briefly."
---

Here are five bugs from our tracker. Turn them into a verified implementation plan, sequenced as PRs.
