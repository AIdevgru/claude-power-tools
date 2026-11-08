# Use case: tell every session something, then close this one

Ana has four Claude Code sessions on one repo and a cloud session working on the docs. She's in
a fifth session and is about to leave for the day.

1. She types `/all "wrap up: commit your work as WIP and write your status line"`.
2. The skill calls `ListAgents` and sends the message word for word to every row in one parallel
   batch: the four local sessions and the cloud session. It skips its own row, and doesn't wait
   for replies, since the cloud session can't reply.
3. It prints `Sent to 5: ...`, listing any send that failed and why.
4. It runs `scripts/quit.mjs`. The script walks up from its own process to the first ancestor
   that is Claude Code. That is this session's `claude` process, never another session's. A
   detached helper ends it 3 seconds later, after the turn's last line, `Closing this session.`
5. Ana's terminal is back at her shell prompt. The other sessions carry on with the message.

It works the same whether the skill was copied in or linked with `install.mjs --link`.

If she types `/all` with no message, she gets the usage line and the session stays open. If no
message reached anyone, the session also stays open. If the script can't find this session's
process, it closes nothing and tells her to type `/exit`.
