---
description: "Plain phrasing should pick the screenreader skill."
tags: [trigger]
runs: 2
max_turns: 4
allowed_tools: [Skill]
append_system_prompt: "This is a skill-selection test in an empty folder. If one of your skills fits the request, invoke it with the Skill tool, then stop and name the skill you used without doing the work. If none fits, answer briefly."
---

Can someone who uses NVDA actually sign up for the newsletter on https://example.com? Have a screen reader user try it and write up what gets in their way.
