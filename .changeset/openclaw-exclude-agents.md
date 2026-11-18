---
"harnery": minor
---

The OpenClaw plugin accepts `excludeAgents`, a list of agent ids it never records, even when `agents` is empty and every other agent is recorded. Use it to keep the prompts of an agent that handles personal data, such as a customer-facing assistant, out of the Event Ledger.
