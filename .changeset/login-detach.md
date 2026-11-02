---
"harnery": minor
---

`browse --login --detach` returns as soon as the sign-in window is open and prints a sentence for the agent to pass on to the person, plus a close file and a log. A background process waits for the window to close and copies the cookies as before. The `harn-computer` sign-in step now uses it, so an agent no longer waits silently on a person, or loses the cookie copy to a command time limit.