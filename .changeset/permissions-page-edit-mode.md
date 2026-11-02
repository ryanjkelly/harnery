---
"harnery": patch
---

The dashboard's Permissions page lets a person change their own computer-use
mode for the project (off, ask before each task, ask once per session, on, or
the default). It runs `computer mode`, so loosening still shows the
confirmation pop-up; the page waits for the answer and reports whether the
mode changed, was declined, or timed out. The change is accepted only from a
browser on the same computer: requests through a tunnel or proxy, or posted
from another site, are refused, and remote viewers see no control. Every
other setting on the page stays read-only.
