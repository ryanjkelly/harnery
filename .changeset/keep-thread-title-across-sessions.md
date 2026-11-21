---
"harnery": patch
---

A session that starts in a T3 Code thread an earlier session already titled now keeps that title instead of renaming the thread. A thread that switched account or provider started a new session, and that session's first `agents set-task` used to retitle the open thread. The command now returns `first_of_session: false` with the existing title in `kept_thread_title`, and only the terminal `[DONE] ` title may follow. The done instruction also quotes the title the thread really carries.
