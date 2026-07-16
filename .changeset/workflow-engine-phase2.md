---
"harnery": minor
---

New `harn workflow run <script>`: bounded, schema-gated, conditionally-routed multi-subagent workflows. Scripts are plain JS (`export default async ({agent, parallel, stage, log}) => …`); subagents spawn as headless harness-CLI subprocesses (claude-code adapter first) and are coordination-registered — hooks stay on, with a new `stop-hook.workflow_child` exemption (`HARNERY_WORKFLOW_CHILD=1`) so headless children skip the human-facing end-of-turn ritual without losing heartbeat/event capture. Runs journal to `.harnery/workflows/<run-id>/journal.jsonl`. Design record: decision 0015.
