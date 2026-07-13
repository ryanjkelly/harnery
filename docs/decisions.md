# Architecture Decision Records — harnery

Chronological record of design decisions, alternatives explored, and outcomes.

---

## ADR-001: Require YAML frontmatter for lifecycle status

**Date:** 2026-07-13
**Status:** Accepted

### Context

The docs tooling originally read lifecycle status from bold Markdown lines such as `**Status:** open`. That convention was hard to parse reliably because status tokens, notes, punctuation, and placement varied across repositories. Harnery introduced a shared YAML-frontmatter parser and a bulk `docs frontmatter-migrate` command so hosts could convert without interrupting lint, sweep, or index behavior.

Once the initial host corpus had been migrated, retaining the fallback would leave two competing metadata contracts indefinitely. It would also let newly created bold-only files pass lint, including archived plans and handoffs that the earlier lint scope did not check.

### Alternatives considered

- Keep dual-read support permanently. This avoided a cutover but preserved ambiguous metadata and allowed legacy files to keep entering the corpus.
- Keep dual-read reads but warn on bold-only files. This prolonged the transition and made CI enforcement dependent on consumers treating warnings as failures.
- Require YAML after a verified bulk migration. This creates one canonical contract and keeps legacy parsing isolated to the migration command.

### Decision

`readDocStatusFromText` and `hasYamlStatus` read only a leading YAML `status:` field. `docs lint` treats missing YAML status as an error for plans, issues, handoffs, and archived plans. `docs sweep` and `docs index` use the same YAML-only reader.

The legacy bold parser remains only in `docs frontmatter-migrate`, where it is needed to convert an unmigrated host explicitly. It is not a runtime compatibility path.

### Result

The initial host migration completed with zero remaining updates or errors from `harn docs frontmatter-migrate`. Harnery's focused and full test suites pass with fixtures proving that bold-only lifecycle files fail lint while YAML-backed files pass. This establishes leading YAML frontmatter as the single lifecycle metadata contract.
