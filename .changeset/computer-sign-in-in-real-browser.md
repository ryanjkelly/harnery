---
"harnery": patch
---

Stop the `harn-computer` skill from sending a person to sign in inside a driver-owned isolated browser. That browser runs under the DevTools protocol, so sites such as Google flag it as automation, show bot checks and may lock the account. The skill now keeps isolated browsers for pages that need no sign-in, asks before attaching to the person's running browser when their session is needed, and falls back to the plain `browse --login` window for a sign-in.
