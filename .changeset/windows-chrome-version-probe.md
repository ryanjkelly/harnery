---
"harnery": patch
---

Reading the Chrome version on Windows no longer opens a browser window. `chrome.exe` has no console `--version`: running it starts the browser, and with Chrome already open it opened a blank New Tab window in the operator's Chrome on every headless browse launch. On Windows the version now comes from the executable's version resource, and nothing runs.
