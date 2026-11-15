---
"harnery": minor
---

Link workers started through a client's delegate tool (T3 Code `delegate_task`) to the session that delegated them. Each side records a fingerprint of the shared thread id; a link pass writes `agent.started`, so delegated workers share their parent's claim and commit group, and `agent.completed` when they end or finish, so the finalizer ends them (ADR 0268). Adds the `agent.delegation_keyed` V3 event.
