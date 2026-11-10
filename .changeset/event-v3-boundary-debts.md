---
"harnery": patch
---

Clear the last Event V3 reader-boundary exceptions. The canonical reader now exports `readEventV3ActiveTailV3`, a bounded raw tail read of the active file that the coordination health snapshot uses instead of opening the file itself. The writer exports `eventV3DiagnosticsRootV3` for the loose diagnostics directory, which doctor now uses, and epoch recovery takes the closed-epoch root from `eventV3ArchivesRoot`. Behaviour and output are unchanged.
