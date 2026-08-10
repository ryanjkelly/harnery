---
"harnery": patch
---

Emit `status_box_present_strict` on `turn.stop`: the assistant-text-only variant of the rule-2/3 status-box detection, shadow telemetry alongside the existing loose scan (which also matches the box inside the status command's own tool_result row). The Stop verdict does not read it yet; the field exists to measure the divergence rate before deciding whether the gate flips to the strict scan.
