---
"harnery": patch
---

Detect a stored cursor-agent login for billing checks. The probe reads the
CLI's `auth.json` at the same location the CLI resolves (`CURSOR_CONFIG_DIR`,
then the platform config directory), so `harn doctor` and workflow billing no
longer report the Cursor login as unverifiable, and a `CURSOR_API_KEY` that
would override a subscription login is refused like the other adapters.
