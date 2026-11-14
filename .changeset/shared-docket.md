---
"harnery": minor
---

Share the decision docket across machines. With `{ "decision": { "share": true } }` in the project config (or `HARNERY_DOCKET_SHARE=1`), each machine publishes its waiting decisions, pending run approvals, and recently changed decisions to `refs/harnery/docket/<machine>` on the presence transport, capped by count and at 48 KiB. `decision list --remote` and `approval list --remote` include other machines' copies, and `decision show`, `decision search`, and `approval show` fall back to them. Remote items are labelled with their source machine, flagged when stale, and print an `agents ping` line for their owner. Changing a remote item is refused with that pointer; resolution stays on the filing machine. The `approval` subcommands now live in their own command module.
