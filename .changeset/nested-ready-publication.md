---
"harnery": patch
---

Allow synchronous nested event publications to share their outer writer's lease. Keep epoch cutovers exclusive until every in-flight ready row has been published.
