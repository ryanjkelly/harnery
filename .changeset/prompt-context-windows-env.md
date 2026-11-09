---
"harnery": patch
---

On Windows, the prompt-context provider's allowlisted environment matches variable names without regard to case, so a host environment that spells PATH as `Path` still passes it to the provider.
