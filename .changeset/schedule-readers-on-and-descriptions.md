---
"harnery": minor
---

`schedule list` now runs every reader by default, including the T3 Code and Codex app readers (ADR 0277). The operator switches a reader off with `schedule.disabledReaders` in any config file; the lists from the user-global, project and machine-local files are joined, so no layer can turn back on a reader another switched off. The `schedule.readers` opt-in list is removed.

Schedule records gain an optional `description`: a systemd timer's service `Description=` (or the timer's own), or a Harnery job's new `description` field, which `schedule add --description` sets. Editing a description does not stop an enrolled job. The Codex app reader now also detects WSL from the kernel release, so a process without `WSL_*` variables, such as a systemd service, finds the Windows-side store.
