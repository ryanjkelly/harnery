---
"harnery": patch
---

Service and server stops signal processes on macOS again, and on Linux hosts without Python pidfd support. The start-token recheck before each signal stays, and the semantic service stop sends SIGTERM again after writing its durable stop request.
