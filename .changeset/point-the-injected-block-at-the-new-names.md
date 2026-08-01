---
"harnery": patch
---

Point the injected instructions block at the renamed commands.

The block spliced into a consuming project's `AGENTS.md` still told agents to run `workflow run <script>` and `workflow approvals list`. Both moved in the same release that added those lines. They are now `run <script>` and `approval list`.
