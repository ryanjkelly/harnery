---
"harnery": patch
---

Key diagnostic home-path pseudonyms with a per-install secret so a shared bundle no longer lets anyone confirm a guessed user name by hashing it. The secret is created on first use at `$XDG_STATE_HOME/harnery/diagnostic-identity.key` (default `~/.local/state`, mode 0600) and never enters a bundle. Pseudonyms stay stable on one install and distinct per home; finding and timeline IDs derived from home paths change once on upgrade.
