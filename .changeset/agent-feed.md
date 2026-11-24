---
"harnery": minor
---

Add one feed of agent messages and journal entries. `core/feed` reads a machine's inbox histories, outgoing mail log, and journals into a single time-ordered list, and the dashboard shows it on a new Feed page. With `feed.share: true` in the project config, each machine also publishes its last three days of items to `refs/harnery/feed/<machine>`, so every machine's Feed page includes the messages and journal entries that stayed on other machines (ADR 0274).
