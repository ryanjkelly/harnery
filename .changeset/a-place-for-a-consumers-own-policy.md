---
"harnery": minor
---

Give a consumer's own coordination policy the same lifecycle as harnery's block.

The instructions block harnery splices into `AGENTS.md` is generic on purpose, because it ships to every consumer. A project with real policy of its own therefore had nowhere machine-managed to put it, and hand-maintained it next to the block, where nothing kept the two in step and nothing reported when the hand-written half went stale.

Name a file instead:

```jsonc
// .harnery/config.jsonc
{ "instructions": { "hostAddendumFile": ".agents/host-instructions.md" } }
```

`init` splices that file's contents into a second managed region right after its own block, `init --check` reports drift against the source, and `deinit` removes it. Deleting the config key and re-running `init` takes the region back out, so turning the addendum off needs no new command.

Harnery never parses or renders what the file says. That is what keeps one generic mechanism useful to consumers whose policies have nothing in common, and it is why the config key won over exporting the splicer as a primitive: `init` and `deinit` are registered inside harnery, so a host wiring its own region would have had to wrap both commands and reimplement apply, refresh, check, and remove.

A path that is absolute, escapes the project, is missing, or is empty fails the run before the first write, so a mistake leaves `AGENTS.md` exactly as it found it rather than silently dropping a section the host believes is still there.
