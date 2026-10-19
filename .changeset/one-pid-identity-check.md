---
"harnery": patch
---

One process-identity check, `verifyProcessGeneration`, replaces `checkPidToken` and `tokensAgree`. A Linux start token written without a boot segment is compared on its tick count: a different count proves a recycled pid, and an equal count stays unknown, so such a token can no longer be read as proof of the same run, and a service whose recorded tick count differs is now reported as stopped instead of unknown.
