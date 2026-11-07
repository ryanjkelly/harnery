---
"harnery": patch
---

Judge native Windows memory by the strain rule as well, so low available memory alone no longer raises resource pressure there, and count commit near its limit as strain only when the paging file cannot grow.
