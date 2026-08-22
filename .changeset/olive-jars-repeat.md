---
"harnery": minor
---

`harn browse` trio mode now writes a standalone `<prefix>.html`: stylesheets are inlined, fonts and images are embedded as `data:` URIs, and every remaining reference is rewritten to an absolute URL on the captured origin. Root-relative asset paths previously resolved against whatever host served the saved file, so a snapshot opened anywhere but its own origin rendered as unstyled text with broken images. Scripts and preload hints are dropped, and the trio `.json` reports what was inlined under `htmlSnapshot`. Print mode and `--selector` captures still emit the raw serialization.
