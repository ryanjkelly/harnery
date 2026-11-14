---
"harnery": minor
---

Add `presence pin <mobile|office>` and `presence unpin` to control automatic mobile/office detection. Pinned records stay unchanged by prompt detection. `presence get` now reports state, source, and pin status in plain output and includes `pinned` in JSON. Scripts that compared the plain output to a state should read the JSON `state` field instead. `presence set` remains a one-shot change and removes any pin.

Infer mobile from curly quotes only in a single paragraph of at most 400 characters after removing fenced code and quoted lines. Longer or multi-paragraph pasted prose preserves the current state. Straight quotes still infer office at any length, and the existing short trailing-space rule remains unchanged.
