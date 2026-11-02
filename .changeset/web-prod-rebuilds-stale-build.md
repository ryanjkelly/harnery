---
"harnery": patch
---

`harn web up --prod` and `harn web start` now rebuild the dashboard before starting when its production build is missing or was made from different sources, so pages added by an update no longer return 404 until someone runs `harn web build`. Each build writes a source stamp into the build directory: Git tree hashes of `web/` and `src/` plus uncommitted changes in a checkout, or modification times elsewhere. A build without a stamp counts as stale. The check runs after the port check, prints one line saying why it rebuilt, and starts the server only if the build succeeds. `--no-rebuild` serves the existing build as before.
