---
"harnery": patch
---

`browse --login` under WSL now keeps browser-session cookies and reports where the sign-in ended. Before the Windows sign-in window opens, the dedicated profile is set to continue where it left off, so closing the window no longer deletes cookies that have no expiry date, and the headless read restores the last session so those cookies are copied into the store. The read also lists the pages left open on the sign-in site and prints the last one as `[--login] Last page: <url>`, plus a JSON `login` summary on stdout with `lastPage`, for sites whose landing address carries a per-session token. Closing the profile now fails loudly when a Chrome process survives, and both the sign-in and the read refuse to start while Chrome is still open on the profile instead of handing off to the open window.
