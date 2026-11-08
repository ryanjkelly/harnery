---
"harnery": minor
---

Human-facing times follow a configurable time zone instead of a fixed one. `resolveTimeZone()` reads `HARNERY_TIME_ZONE`, then the project's `.harnery/config.jsonc` `timeZone`, then the user-global `timeZone`, then the system zone, then UTC. An invalid value is skipped with a warning, and `harn doctor` reports it as a failure.

Journal timestamps now carry a numeric UTC offset (`## 2026-11-07 10:38 PM -06:00 · note`, and the same form for `started:` and `last_updated:`). The CLI and the dashboard share one journal codec, and every journal write holds one lock. `harn journal migrate` rewrites timestamps from the retired zone-abbreviation format (dry run unless `--yes`; covers archives; saves originals; idempotent), and the session-start janitor runs it automatically. Writers refuse a journal that still has retired timestamps and name the command.

Breaking: `harn context --json` reports `time.local` and `time.zone` in place of the zone-named time field, and the journal module's `formatChicago` export is replaced by `formatJournalTimestamp(date, zone)` and `formatJournalNow()`.
