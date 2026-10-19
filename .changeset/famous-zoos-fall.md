---
"harnery": patch
---

Give local server registrations immutable receipts and serialize registration, activity, stop and cleanup by ID. Export the existing no-clobber lease primitive for host launch custody. Preserve exact receipt custody through asynchronous host effects. Refuse live duplicate registrations, stale cleanup and older records without custody. Tunnel lifecycle commands preserve launch witnesses, use retained process handles and keep uncertain state instead of terminating processes by PID, command line or port.

Serialize tunnel lifecycle and actual Tailscale routes across provider effects. Atomically retain pending provider intent before effects, publish ready state only after success, and preserve route custody when cleanup fails.
