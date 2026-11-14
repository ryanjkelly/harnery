---
"harnery": minor
---

Add `machine specs` (and `machine` alone) to describe this machine: OS and build, CPU and cores, memory, GPUs with video memory, local disks, displays, Bun and Node versions, and under WSL a separate Windows host block. The description is recorded once per machine in `machine-specs.json` beside the user config and probed again only when a read finds it stale: another boot, another Harnery version, another record format, or older than `--max-age` (24 hours by default). `--refresh` probes now, and `--json` prints the record with memory available and disk free measured at read time. A section that cannot be read is listed under `errors` instead of failing the command, and the record never holds serial numbers, network addresses, user names, home paths, or the hostname.
