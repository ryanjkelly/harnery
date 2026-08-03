---
"harnery": patch
---

Declare each shared type once.

Three types were declared more than once with byte-identical bodies, which is how two modules quietly drift into disagreeing about a shape they are supposed to share. The closed adapter-id union and the event `Source` union now live only in the hooks event schema, re-exported by the two event modules that kept their own copies. The rule verdict shape moves to `core/agents/rules/verdict.ts`, imported by both the claim-conflict and stop-hook rules. No shape changed, so nothing observable moves.

The `Heartbeat` interface is deliberately left alone. Its two declarations look like duplicates but are not: the writer's view has optional fields the reader's view requires, so unifying them is a behaviour change rather than a cleanup.
