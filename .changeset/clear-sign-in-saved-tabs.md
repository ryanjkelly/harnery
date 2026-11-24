---
"harnery": patch
---

`browse --login` under WSL clears the sign-in profile's saved tabs before it opens the window. The profile continues where it left off so browser-session cookies survive, and each headless run on it added a blank tab to the saved session, so the window opened with every tab from earlier sign-ins. Cookies are untouched.
