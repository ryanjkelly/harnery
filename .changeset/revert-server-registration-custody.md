---
"harnery": patch
---

Server and tunnel commands work again. Since 0.45.0, a server record written by an earlier version made `servers` listing, stop, gc, unregister and port allocation fail, and every tunnel started before the upgrade showed `unknown`, so tunnel file links, `tunnel down` and `tunnel reload` refused. Server records are back to schema 1, tunnel readiness uses the live state check, and stopping a server signals its process group again so child processes stop with it. This reverts ADR 0220, now withdrawn.
