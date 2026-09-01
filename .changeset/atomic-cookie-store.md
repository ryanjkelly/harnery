---
"harnery": patch
---

Serialize shared cookie-store updates across processes, replace the store
atomically, and report stable parse failures as a cookie-loading stage with the
exact store path while preserving the malformed file.
