---
"harnery": patch
---

A session that starts in a T3 Code thread an earlier session already titled now keeps that title's description and changes only the agent name. A thread that switched account or provider started a new session, and that session's first `agents set-task` used to retitle the open thread with its own task. The command now returns the existing title in `kept_thread_title`, and `suggested_session_name` is that title with the new agent name. `titleChangeAllowed()` permits an agent-name change after a title is applied, so an `Agent unknown - ...` title also gains its real name once identity resolves. The done instruction quotes the title the thread really carries.
