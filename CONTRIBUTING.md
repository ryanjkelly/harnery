# Contributing to Harnery

Harnery is a solo, pre-1.0 project. Bug reports and small, focused PRs are welcome, but I can't promise every PR lands: the API is still settling, and I may decline changes that don't fit the project's direction. For anything bigger than a bug fix, please open an issue first so we can agree on the approach before you write code.

This document covers the basics: local dev setup, code style, commit conventions, and the release process.

## Local development

Requires:

- [Bun](https://bun.sh) 1.3+: recommended for dev (zero-build TS execution; the bins run `src/` directly)
- Node 20+: the published package targets Node; only needed locally to test the built `dist/`
- A POSIX shell (Linux, macOS, or WSL)

```bash
git clone https://github.com/ryanjkelly/harnery.git
cd harnery
bun install
bun test
bin/harn --help
bun run build        # optional: produce dist/ and exercise the Node path (tsc + dts fixup)
```

## Code style

[Biome](https://biomejs.dev/) handles lint + format. CI runs both on every PR (see `.github/workflows/ci.yml`); run them locally before pushing:

```bash
bun run lint
bun run format
```

`tsconfig.json` is strict-mode TypeScript. New modules ship with corresponding `*.test.ts` Bun-tests under `tests/` or alongside the source.

## Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`. Subject lines under 70 characters.

## Changesets + releases

Every PR that changes published behavior includes a [changeset](https://github.com/changesets/changesets) file:

```bash
bun x changeset
```

Walk through the prompts to declare the bump type (patch/minor/major) and a one-line summary. The release workflow on `main` consumes pending changesets, bumps the version, regenerates `CHANGELOG.md`, and publishes to npm.

## Adding a new command

1. Create `src/commands/<name>.ts` (or `<name>/index.ts` for larger commands) exporting a `register<Name>Command(program: Command)` function (Commander pattern).
2. Wire the registration in `src/commander.ts`.
3. Add a `*.test.ts` covering the command's surface, alongside the source (e.g. `src/commands/<name>.test.ts`) or under `tests/`.
4. Document the command at `docs/src/content/docs/cli/<name>.mdx`.
5. Include a changeset describing the addition.

## Reporting bugs

Use the [bug report issue template](https://github.com/ryanjkelly/harnery/issues/new?template=bug_report.md). Please include `harn --version`, your Node + Bun versions, and a minimal reproduction.
