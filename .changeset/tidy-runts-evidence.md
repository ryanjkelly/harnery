---
"harnery": patch
---

Allow browse runt checks to retain an explicitly bounded findings list through
`--check-runts-max-findings` or `Browser.checkRunts({ maxFindings })`. The default
50 findings, 5,000-block scan cap, detection rules, and failure behavior stay
unchanged. Invalid bounds fail before the sweep.
