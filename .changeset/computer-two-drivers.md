---
"harnery": minor
---

`computer` now ships two pinned desktop drivers that share one desktop lease: Cua Driver and agent-desktop 1.0.2, which reads the accessibility tree as snapshots and acts on refs scoped to each snapshot, with no daemon. `--driver <id>` on `call`, `tools`, `describe`, `install`, `up`, `down` and `doctor`, or `computer.driver` in project config, picks one; `install`, `up`, `down` and `doctor` cover both by default. Both drivers now install and run on macOS (Cua Driver's signed app bundle goes to `/Applications`) and Linux desktops as well as Windows and WSL. `status --json` lists drivers under `drivers` with `default_driver`; `doctor --json` reports `{ ok, drivers: [...] }`. Inline base64 screenshots under any key are redacted from `call` output. ADR 0231.
