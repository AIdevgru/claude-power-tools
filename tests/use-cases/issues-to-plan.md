# Use case: turning an issue list into a plan

Lee has a doc with eight typed-up issues from a customer call. He wants a plan he can trust, not code.

1. He types `/issues-to-plan docs/call-issues.md`. He can also paste the issues.
2. Pass 1: the skill numbers the issues as the source does. It sends one `Explore` agent per area, in parallel. Each returns `path:line` conclusions and also searches likely misspellings.
3. It reads the cited lines itself before trusting a summary. It checks that any feature an issue assumes exists at all, and says so at the top of the plan if it does not.
4. For each issue it writes the current behaviour, the root cause (called verified only if it read the code), numbered plan steps, tests and the owner decisions that change the design.
5. Pass 2: it reviews its own draft as if someone else wrote it. It re-checks every `path:line`, tests rules against any sample Lee supplied, finds contradictions and gaps, and appends a Review changelog.
6. Pass 3: it restructures the document into a delivery sequence table, owner decisions with recommended defaults, one section per PR, a validation gate and the changelog.
7. The plan sits next to the source as `<source-name>-plan.md`. If the issues were pasted, it goes in the repo's plans folder.
8. If Lee supplied a customer sample, it records the shape only. It never records names, amounts or other identifying values, and never copies the file into the repo.
9. The skill only plans. It never implements, commits or pushes. Its reply gives the plan path, the top findings, the blocking decisions and which PRs can start now.
