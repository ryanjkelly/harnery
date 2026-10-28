---
"harnery": minor
---

`HarneryProgramContext.headerPolicy(host, name, value)` lets a host CLI check
each `-H` header `fetch` was given before any request is sent. A refusal stops
the run with the host's message and a nonzero exit. The new
`FetchHeaderDecision` type is exported from `harnery/commander`.
