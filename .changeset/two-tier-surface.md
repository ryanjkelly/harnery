---
"harnery": minor
---

Declare the two-tier public surface (ADR 0010): product tier (`.`, `./commander`, `./core/*` — the coordination layer) vs toolkit tier (`./lib/*` — supporting utilities for embedding hosts). BREAKING (pre-1.0): the `./lib/scratch` export is now `./core/scratch` — scratchpads are a coordination feature, and the source moved to `src/core/scratch/` accordingly. A new CI layering guard (`scripts/check-layering.ts`) enforces that no `./lib/*` export imports the coordination core, directly or transitively. README, package description, and docs now lead with coordination; the toolkit is documented as batteries for embedders (see the new "Embedding + surface tiers" concepts page).

Also fixed: `init` now honors a `binName` already pinned in `.harnery/config.jsonc` instead of re-stamping the invoking CLI's name over it (`pinnedBinName()`), and the portability scanner covers the agent-facing surfaces (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.harnery/config.jsonc`) so a host bin name can't silently land in committed files.
