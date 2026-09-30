---
"harnery": minor
---

Add `claude-desktop share`, which shares Claude desktop sessions between a person's computers through a synced folder (iCloud Drive by default on macOS). Each machine publishes its recent sessions under its own folder and imports every other machine's, so a session started on one computer is listed and resumable on the other. A remote transcript replaces a local one only when the local file is missing or an exact prefix of it; longer, diverged, or live local transcripts are never overwritten. Dry-run by default; `--yes` applies.
