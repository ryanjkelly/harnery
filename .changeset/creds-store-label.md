---
"harnery": minor
---

The credential toolkit (`harnery/lib/creds`) no longer assumes 1Password. A host can pull a source in code instead of through a script: leave out `script` and register a function under `hooks.pull[key]`, which writes the source's files and throws with a safe message on failure. `CredsHostConfig.store` names the password store in help, messages and the missing-tool error, and defaults to 1Password, so existing hosts see no change. The engine's `op` dependency is now the narrower `CredentialStoreClient` (`detectOp` and `getItemFields`), which Harnery's 1Password client still satisfies.
