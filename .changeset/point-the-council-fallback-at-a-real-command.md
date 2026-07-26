---
"harnery": patch
---

Point the injected instructions block at a council command that exists

When a consumer excludes the `harn-council` skill, the generated AGENTS.md block
fell back to telling agents to run `<bin> council --help`. There is no top-level
`council` command; the surface is `<bin> agents council`, so that pointer sent
every agent on such a project to a command that does not resolve. The fallback
now names `<bin> agents council --help`. Consumers that ship the skill were
unaffected, since they get the skill pointer instead of the fallback.
