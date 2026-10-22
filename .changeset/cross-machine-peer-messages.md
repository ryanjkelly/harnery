---
"harnery": minor
---

`agents ping` now reaches agents on other machines that share the repo's origin. A name not known locally is matched against other machines' presence and recent mail senders, queued in this machine's `refs/harnery/mail/<machine>` ref, and imported into the recipient's inbox when its machine next fetches. New `presence mail` shows unacknowledged cross-machine messages (ADR 0222).
