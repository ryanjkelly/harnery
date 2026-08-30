---
"harnery": patch
---

Report every missing end-of-turn signal in one Stop verdict instead of one per continuation.

The Stop rule returned on its first failing check, so a turn that was missing the status observation, the pasted status box, and the task declaration cost three separate continuations to repair. Each continuation forks a fresh hook process, so on a busy multi-agent host the ritual's own enforcement added to the hook load it polices. The verdict now collects every failing signal, keeps the first failure's rule id so `blocked_rule` telemetry and the adapter's `rule=` stderr contract are unchanged, and enumerates the rest in the reason so a single continuation repairs all of them.
