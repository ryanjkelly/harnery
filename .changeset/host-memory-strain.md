---
"harnery": patch
---

Stop low Windows host memory from raising resource pressure on its own. The host now also reports commit against its limit and the hard page-in rate, and is raised only when low availability comes with one of those strain signals for three samples. Raised states name their cause, host and machine memory-occupancy findings are reported as information, and status labels the cumulative OOM kill count as history.
