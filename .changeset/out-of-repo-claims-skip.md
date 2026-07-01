---
"harnery": patch
---

Claim guard: skip out-of-repo paths (fixes spurious ordering blocks from scratchpad/temp writes)

The PreToolUse claim guard canonicalized write-tool targets but passed
absolute out-of-repo paths (e.g. a `/tmp` scratchpad) through verbatim, so
they entered the claim system. Because the ordering rule compares raw path
strings, an absolute `/tmp/…` sorts before every repo-relative path
(`/` = 0x2F < any letter), so a scratchpad write spuriously "blocked" a
legitimately-held repo file with an ordering_violation.

`canonicalize` now returns `null` for any absolute path not under `coordRoot`,
and the guard filters those out. Session-private temp files are never shared
coordinated resources and must not be claimed. The logic moved to
`guard-path.ts` with unit coverage. The ordering_violation message was also
corrected: it advised "release the higher claim first", but releasing does not
stick (the heartbeat is re-projected), so it now points to the working escapes
(edit in sorted order, or commit the blocker so it auto-prunes).
