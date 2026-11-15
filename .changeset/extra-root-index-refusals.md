---
"harnery": patch
---

Stop replacing an unreadable finalization path index. A new claim in an extra finalization root that finds `.harnery/finalization-paths/<instance>.json` unparseable now leaves the file alone; the claim is still recorded. The closing check already refused on that file, and its message now names the file and the exact `rm --root <root> --allow-protected <file> <file> --yes` command that clears it, which `rm` permits for that one index file. `agents handoff` now refuses a path outside the coordination repository with `path_outside_repository` and names the release-and-claim route, instead of reporting that the session holds no claim on it.
