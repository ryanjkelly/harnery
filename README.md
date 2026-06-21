<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/harnery-logo-reversed-transparent.svg">
    <img src="assets/harnery-logo-transparent.svg" alt="Harnery" width="300">
  </picture>
</p>

# Harnery

> Multi-agent coordination + harness adapters + portable CLI utilities for Claude Code / Cursor / Codex.

[![CI](https://github.com/ryanjkelly/harnery/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanjkelly/harnery/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/harnery.svg)](https://www.npmjs.com/package/harnery)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> ⚠️ **Pre-1.0.** API surface is still settling. Pin a specific minor version (`harnery@^0.1.0`) and read the [CHANGELOG](CHANGELOG.md) before each upgrade.

## What it is

`harnery` is a utility layer extracted from years of building agent tooling across a multi-project monorepo. It bundles:

- **Multi-agent coordination:** per-agent heartbeats in `.harnery/active/`, claim-time and commit-time guards, the canonical event stream, harness adapters for Claude Code / Cursor / Codex.
- **Portable CLI utilities:** `tokens`, `eml`, `env`, `grep`, `docs`, `repo`, `wip`, `share`, `browse`, `fetch`, `read`, and more. Cross-platform and dependency-light, with sensible defaults out of the box.
- **Standalone web UI:** `harn web up` boots a local Next.js dashboard for the coord layer, councils, and per-project state. Ships with the git clone, not the npm package (see [Install](#install)).
- **Backup + sync:** `harn backup` snapshots `.harnery/` via [restic](https://restic.net/); `harn sync` keeps a curated subset live across machines via [rclone](https://rclone.org/) (Google Drive or any rclone remote).

## Install

```bash
npm install -g harnery
```

Or as a per-project dep:

```bash
npm install harnery
```

Then:

```bash
harn --help
harn doctor   # one-time runtime + dep check
```

> **npm gives you the engine + CLI.** The `web/` dashboard and the `docs/` site live in the git repo, not the npm package (which is the CLI + coord engine: `bin`, `dist`, `src`, `schemas`). To run the dashboard, `git clone` the repo, `bun install`, and `harn web up` from there, pointing it at your project with `--coord-root <dir>` (or just run it from inside the project). `harn web up` prints these exact steps if you invoke it without the clone present.

## Use as a CLI library

Project-specific CLIs compose Harnery's command tree and add their own commands on top:

```ts
// mycli/src/program.ts
import { createHarneryProgram } from 'harnery/commander';
import { deployCommand, dbCommand } from './commands';

const program = createHarneryProgram({
  binName: 'mycli',
  context: { projectName: 'my-monorepo' },
});

program.addCommand(deployCommand);
program.addCommand(dbCommand);

await program.parseAsync(process.argv);
```

`mycli agents status` then resolves to **the same code** as `harn agents status`, loaded as a library. See [examples/extending-with-commander.ts](examples/extending-with-commander.ts) for the full pattern.

## Documentation

Full docs at **[harnery.com](https://harnery.com)**:

- [Getting started](https://harnery.com/getting-started/install)
- [CLI reference](https://harnery.com/cli/)
- [Concepts](https://harnery.com/concepts/coord-layer)
- [Configuration schema](https://harnery.com/reference/config-schema)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and feature requests via [GitHub Issues](https://github.com/ryanjkelly/harnery/issues).

## License

[MIT](LICENSE) © Ryan Kelly
