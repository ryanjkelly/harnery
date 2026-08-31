---
"harnery": minor
---

Make `agents ping` deliver to an agent name rather than to a running instance. A message to a name with no live session is now held in a durable mailbox and delivered when a session of that name next starts, instead of being refused. A message to a live agent is surfaced in their next prompt, which previously never happened: the entry landed in their journal and nothing showed it to them.

The refusal that remains is a name no agent has ever held, and that error lists the closest known names. Senders therefore need one command and no lookup of who is currently running, which is what the previous behavior forced. Per-message and per-mailbox ceilings bound the queue, and delivered messages are archived for audit.

Also fixes the prompt-context route resolving the agent name: the hook does not pass `--name`, so every name-addressed section, pending council invites included, was silently skipped. The name is now read from the heartbeat when the caller omits it.
