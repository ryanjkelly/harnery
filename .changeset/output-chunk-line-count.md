---
"harnery": patch
---

Count the non-empty lines inside one `command.output_observed` chunk instead of
reporting one line per event, so a host can record a whole output body as a
single event without losing the line total.
