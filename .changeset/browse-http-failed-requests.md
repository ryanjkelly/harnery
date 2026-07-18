---
"harnery": minor
---

Browser diagnostics now record HTTP-level request failures: `FailedRequest` gains `status`, `kind` ("http" | "network"), and `document` fields, and the browser client captures responses with status >= 400 alongside the existing network-failure events. Previously a script or stylesheet answered with a 4xx/5xx was invisible to `failedRequests`-based gates (only never-completed requests were recorded). Consumers that count `failedRequests` may see new entries on pages with failing subresources — that is the defect being surfaced.
