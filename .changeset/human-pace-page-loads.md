---
"harnery": minor
---

Read pages at human pace by default. `browse`, `browse-ai`, `fetch`, and the headed browse-session verbs now wait a random 3 to 9 seconds between consecutive loads of the same registrable site, tracked in a shared machine-local ledger (`~/.cache/harnery/pace.json`) so separate processes queue behind each other instead of firing together. Different sites never wait on each other, and loopback, private-network, single-label, and reserved-suffix hosts (`.localhost`, `.local`, `.test`, `.internal`) are exempt so local development and page QA keep machine speed. Each command takes `--no-pace` for one run; `HARNERY_PACE=off` disables the gate machine-wide, and `HARNERY_PACE_MIN_MS`, `HARNERY_PACE_MAX_MS`, and `HARNERY_PACE_EXEMPT` tune it. The gate ships as the `harnery/lib/pace` toolkit export for hosts that load pages through their own clients.
