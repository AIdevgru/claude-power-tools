---
description: "Plain phrasing should pick the video skill."
tags: [trigger]
runs: 2
max_turns: 4
allowed_tools: [Skill]
append_system_prompt: "This is a skill-selection test in an empty folder. If one of your skills fits the request, invoke it with the Skill tool, then stop and name the skill you used without doing the work. If none fits, answer briefly."
---

Make me a 15 second animated teaser video for our command-line tool: dark background, a spinning 3D logo, then three feature cards. I want an MP4 I can post.
