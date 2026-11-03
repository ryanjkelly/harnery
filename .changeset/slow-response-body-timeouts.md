---
"harnery": patch
---

Keep HTTP request timeouts active until response bodies finish reading, including bodies drained before a retry. Clear the timer when response handling fails and start it after request-body serialization succeeds.
