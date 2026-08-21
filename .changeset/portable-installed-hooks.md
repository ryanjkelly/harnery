---
"harnery": patch
---

Keep adapter hooks portable when Harnery is installed outside the consumer repository. `harn init` now writes the installed `agent-hook` executable from `PATH` instead of a developer-machine-relative path, while embedded checkouts continue to use their repository-relative launcher.
