---
"harnery": minor
---

Report unreadable repository observations as unknown in checkpoint recovery and workflow proof. Failed reads no longer claim a checkpoint match or cleared dirty paths.

Guard governor, supervisor, and server stop signals with a process-generation recheck. Missing or different start tokens send no signal. Service status reports generation, running and installed builds, and whether a restart is needed. Server records with unknown identity remain visible; arbitrary stop commands and automatic adoption from old tunnel state are removed. Registry stop controls a tunnel's recorded gate; saved provider-helper PIDs lack generation evidence and are left alone.

Preview `run reclaim` without `--yes`. Both salvage and discard now prove run inactivity and workspace ownership, and hold the resume, binding, and repository leases before changing files. Refusals leave workspace files untouched. The raw reclaim preparation helper is no longer a public export; callers use the guarded provider operation. See [ADR 0207](https://harnery.com/decisions/0207-fail-closed-on-unknown-state/).
