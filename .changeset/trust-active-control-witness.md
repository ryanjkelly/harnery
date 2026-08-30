---
"harnery": minor
---

Authenticate active V3 control state without replaying the complete epoch in every hook process.

Active epochs now carry a root-key-authenticated witness bound to the immutable control pair, the reader's complete storage fingerprint, and a repairable semantic validator checkpoint. Matching witnesses answer the active control question without loading event history. The canonical writer validates each appended suffix against the checkpoint before advancing the witness. Any invalid append, rewrite, segment change, inode replacement, forged witness, or crash gap falls back to canonical full validation, and valid crash gaps repair the witness automatically.

Ordinary hooks also reuse the recorder-proven generation for payload owner resolution, epoch-restoration checks, and the generation-bound session-name cache. A 30 MiB fresh-process `pre-tool-use` benchmark fell from a 1.16-second median and 354,700 KiB maximum RSS to 0.195 seconds and 84,322 KiB.
