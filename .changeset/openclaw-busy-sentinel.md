---
"harnery": patch
---

Name dropped evidence distinctly in the OpenClaw adapter's redacted failure log.

When the memory-only recorder reports `busy` and a signal is dropped, the
`record_failure` debug row now carries `error_name: "RecorderBusyError"`
instead of the generic `"Error"` shared with every other crash. The injected
`recorderFault` switch reports `"RecorderFaultInjectedError"`. Only the fixed
class name is logged, so error text still never reaches the debug log.
