---
"harnery": minor
---

`browse --login` now opens the installed Google Chrome with nothing attached (the Windows host's Chrome under WSL), which is what `--login --plain` did before. Sites can detect an automation-controlled browser however its launch flags hide it, and some disable the account that signed in through one. The automation-controlled headed window now needs an explicit `--login --attached`, and `--control-file` requires both flags. `--plain` is removed: drop it from `--login --plain` commands, and add `--attached` to `--login --control-file` and other agent-driven `--login` commands.
