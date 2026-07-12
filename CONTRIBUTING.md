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

Every PR that changes published behavior (`src/`, `bin/`, `schemas/`) includes a [changeset](https://github.com/changesets/changesets) file. `web/`, `docs/`, and the root scripts are unpublished, so they don't need one.

```bash
bun x changeset
```

Walk through the prompts to declare the bump type (patch/minor/major) and a one-line summary.

### Cutting a release

`main` is the released line; day-to-day work lands on `next`. A release is a `next` → `main` merge, and it runs in two steps:

1. **Fast-forward `main` to `next`.** This carries the pending changesets onto `main`, where the [changesets action](https://github.com/changesets/action) opens (or updates) a `chore(release): version bump + changelog` PR. That PR applies the version bump, regenerates `CHANGELOG.md`, and deletes the consumed changesets. It does **not** publish yet.
2. **Merge the release PR.** Merging it runs `changeset publish`, which publishes to npm (with provenance) and tags the release. Afterward, fast-forward `next` back up to `main` so the consumed changesets don't linger there.

The release PR is opened by the Actions bot, so branch-protection checks never run on it and it sits as `BLOCKED`. Admin-merge it (`gh pr merge <n> --squash --admin`) once CI is green on the `main` commit beneath it: the PR only touches version + changelog metadata, and the code it ships already passed CI on that commit.

**CI only runs on `main`.** Commits to `next` are quiet, so a green `next` is not CI-verified; the full suite runs only once you push to `main`. Run it locally before releasing:

```bash
bun run typecheck && bun run lint && bun test && bun run test:integration
```

The `installers` job also runs only on `main`: it packs the tarball and exercises the `install.sh` / `uninstall.sh` one-liners plus a `scripts/setup.sh` → `scripts/teardown.sh` round-trip. Those shell scripts have no unit tests, so if you touch them, run that round-trip against a throwaway project yourself, or a regression stays hidden on `next` until release.

## Adding a new command

1. Create `src/commands/<name>.ts` (or `<name>/index.ts` for larger commands) exporting a `register<Name>Command(program: Command)` function (Commander pattern).
2. Wire the registration in `src/commander.ts`.
3. Add a `*.test.ts` covering the command's surface, alongside the source (e.g. `src/commands/<name>.test.ts`) or under `tests/`.
4. Document the command at `docs/src/content/docs/cli/<name>.mdx`.
5. Include a changeset describing the addition.

## Product vs toolkit: where new code goes

Harnery's public surface has two tiers (see [ADR 0010](docs/src/content/docs/decisions/0010-surface-tiers.mdx)): the **product tier** (`.`, `./commander`, `./core/*` — the coordination layer) and the **toolkit tier** (`./lib/*` — supporting utilities for embedding hosts). Two things to know before adding an export:

- A `./lib/*` export must never import `src/core/`, directly or transitively. CI enforces this (`bun run check:layering`); if your module needs the core, it belongs under `./core/*` instead.
- New toolkit exports need demonstrated reuse: harnery's own commands use it, or more than one embedding host wants it. Utilities that serve a single host belong in that host's CLI, not here.

## Reporting bugs

Use the [bug report issue template](https://github.com/ryanjkelly/harnery/issues/new?template=bug_report.md). Please include `harn --version`, your Node + Bun versions, and a minimal reproduction.
