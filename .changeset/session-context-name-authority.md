---
"harnery": patch
---

Assert name authority on the session-start self-name line. Adapters that fork or
branch a conversation copy the parent's transcript, so the new session's context
still asserts the parent's agent name, file claims, and task. The fork is a
distinct instance and already receives its own name, but nothing told it to
prefer that over the inherited text. The self-name line now states that a
different name in earlier context came from another session and this one wins.
