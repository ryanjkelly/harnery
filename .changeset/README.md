# Changesets

Each PR that changes published behavior should include a changeset file in this directory describing the change.

| Pending change | Purpose |
| --- | --- |
| [windows-coordination-helpers.md](windows-coordination-helpers.md) | Native internal coordination calls and hook lifecycle verification |
| [native-windows-source.md](native-windows-source.md) | Native Windows launchers, initialization, and process identity |

To add one, run:

```bash
bun x changeset
```

The CLI prompts for:

1. Which packages changed (in a single-package repo like this one, always `harnery`)
2. The bump type: patch / minor / major
3. A one-line summary of the change

Commit the resulting `.md` file alongside your PR. The release workflow on `main` consumes pending changesets, bumps the version in `package.json`, regenerates `CHANGELOG.md`, and publishes to npm.

For more, see the [changesets docs](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md).
