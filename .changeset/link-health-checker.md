---
"harnery": minor
---

Add `harn docs links`: an internal Markdown link checker that resolves relative targets and validates the heading fragments they point at. Reports `missing-target`, `missing-fragment`, `case-mismatch` (with the on-disk path as a suggestion), and opt-in `escapes-repo`. Fragments are matched against GitHub's anchor rules, including duplicate-heading `-1`/`-2` suffixes, `{#custom-id}` suffixes, and HTML `id`/`name` attributes.

Built for a low enough noise floor to be worth reading: code fences and inline spans are masked before parsing, external/`mailto:`/protocol-relative/root-absolute targets are skipped, template placeholders (`{{x}}`, `${x}`, `<placeholder>`) are treated as unresolvable by design, `#L42` line refs and `#/spa/route` hash routes are never treated as headings, and findings in `archive/`, `audits/`, `changelogs/`, `handoffs/`, and `decisions/` documents are downgraded to warnings (`--strict` opts out). Per-link `<!-- links-allow: reason -->` and per-file `<!-- links-allow-file: reason -->` escape hatches cover the rest. Advisory by default — `--fail` is the opt-in exit-code gate, so making link health blocking stays a host decision.
