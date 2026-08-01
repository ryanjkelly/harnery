---
"harnery": minor
---

Rename the rest of the command surface so one word means one thing.

Four changes land together because they are one vocabulary, and there are no aliases or deprecation windows: pre-1.0 is when a hard rename is free.

**`harn harness` becomes `harn adapter`.** Blind naming panels could not read `harness` at all — every run called it guesswork, and more than one noted the word has to be defended against its own connotation before it can be understood. The panel's own favourite replacement was `provider`, and that was the plan of record until the collision was counted: `provider` already carries five unrelated meanings in this tree, two of which reach user-visible output. `adapter` carries exactly one. Every occurrence of it in the source was already this concept, so the command name now matches the word the implementation had picked for itself.

**`harn workflow run <script>` becomes `harn run <script>`.** One bounded execution should not need two verbs to start. The run-scoped subcommands stay where they were, under `run`.

**`harn context` splits.** Its continuity half becomes a top-level `harn checkpoint` with `status`, `create`, and `show`. Its orientation snapshot moves to `harn agents context`, unchanged and with every flag intact — it belongs under the noun for live sessions, which is what it reports on.

**`harn agents council` becomes `harn council`, and `harn workflow approvals` becomes `harn approval`.** Both were buried where nobody found them. Deliberation and authorization are things a reader looks for by name at the top level, not features they stumble into three levels down.

One implementation note worth recording, because it will look like a mistake to anyone reading the source. Executing a script is a hidden default subcommand of `run` rather than an action on `run` itself. Commander binds an option to the nearest command that declares it, and `run` shares several option names with its own subcommands, so a parent-level action silently swallowed the child's copy of `--policy` and `--json`.
