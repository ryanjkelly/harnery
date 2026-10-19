---
"harnery": patch
---

Bind service and server signals to retained Linux pidfds or Windows process handles. Refuse direct signals when native handle support is unavailable, preserve durable service stop requests, and keep Windows process creation tokens consistent across native and standalone readers. Remove the unreachable legacy resource service launcher.
