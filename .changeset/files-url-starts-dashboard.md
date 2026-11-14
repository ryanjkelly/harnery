---
"harnery": minor
---

`files url` can start the dashboard when it does not answer. Set `files.start_command` (an argv array) in `.harnery/config.jsonc`, and optionally `files.start_timeout_seconds` (default 600). The command runs once under a start lease, so concurrent callers start one server, and `files url` waits for the dashboard to report this repository before printing the link. On failure or timeout the `dashboard_unreachable` error names the command and its log. `--no-start` skips the start.
