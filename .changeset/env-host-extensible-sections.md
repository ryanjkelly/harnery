---
"harnery": minor
---

`harn env` sections are now host-extensible, and harnery core no longer ships provider-specific checks. Core previously carried built-in `gcp` and `bq` (Google Cloud / BigQuery) connectivity sections, which is opinionated cloud coupling for a generic tool. Core now ships only the generic sections (`runtimes`, `docker`, `git`); an embedding host registers its own via the new `context.envSections` (a `Record<string, EnvSection>` on `HarneryProgramContext`, with exported `EnvSection` / `EnvCheck` types). Host sections merge in after the generic ones, so `harn env <name>` and the full report pick them up automatically. Standalone `harn env` no longer has `gcp`/`bq`; a host that wants them registers them.
