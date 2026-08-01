---
"harnery": minor
---

Rename the supervisor to the governor.

`harn supervisor` becomes `harn governor`. No alias, no deprecation window — the repo is pre-1.0 and a hard rename is cheaper now than a vocabulary split later.

The old name asked readers to hold a hierarchy in their heads. A supervisor supervises somebody, so the first question it raises is who reports to whom, and the answer is nobody: the command drives a graph of durable work toward a goal and decides how much it may settle before a human is needed. That is authority over a process, not management of people. Blind naming panels read `supervisor` as a manager of agents in every run; they read `governor` as the thing that bounds how far something runs on its own, which is what it does.

The code had already reached for the word without anyone deciding to. The subsystem talks about governance events, governed work, and what governs what. The command name now matches the vocabulary the implementation had picked for itself.

Everything moves with it: `SupervisorRecord` and its family become `Governor*`, the `.harnery/supervisors/` and `.harnery/supervisor-service/` state directories become `.harnery/governors/` and `.harnery/governor-service/`, the dashboard route becomes `/governors`, and the docs page moves. Runtime state under `.harnery/` is untracked, so an existing checkout needs its two directories renamed by hand or simply left behind.

Decision records 0025 and 0026 keep their titles. They are historical, and "supervision" is still an accurate English description of what a governor does to a goal.
