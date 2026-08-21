---
"harnery": patch
---

agents ping now emits a canonical `state.ping` event carrying the complete delivery record (sender via the envelope, `peer_instance_id`/`peer_name` in data, bounded `body_summary`). Previously a ping was only a journal append plus generic command capture, so no read-only observer could see that a directed message happened without joining journal files. Additive event type per the schema's forward-compatibility rules; consumers that don't know it ignore it.
