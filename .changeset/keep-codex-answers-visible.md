---
"harnery": patch
---

Make end-of-turn coordination checks observe-only on Codex. Harnery still records
the turn and projects agent state, but it no longer uses a Stop continuation that
can replace the completed user-facing answer with a status retry.
