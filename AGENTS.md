# harnery: agent instructions

Multi-agent coordination for AI coding agents — Claude Code, Cursor, and Codex. Pre-1.0, MIT, published to npm as `harnery` (binaries: `harn`, `agent-coord`, `agent-hook`). Bun-first for dev (zero-build TS execution); the published package targets Node ≥ 20.19. A host CLI composes the command tree via `createHarneryProgram({ binName, context })` from `harnery/commander` and adds its own commands on top. Pattern: [examples/extending-with-commander.ts](examples/extending-with-commander.ts).

## Portability is the prime constraint

This package serves arbitrary host projects. Nothing host-specific may land in `src/`, `web/`, `docs/`, or `schemas/`: no host names, hostnames, business vocabulary, hardcoded `/home/<user>/...` paths, or single-bin assumptions. Bin name, project context, and event emit are injected by the host CLI; anything project-specific belongs in the host, not here. Runtime state lives in the **host project's** `.harnery/` directory (`events.ndjson`, `active/`, `councils/`, `scratch/`, `identities/`, `pid-map/`), resolved via `coordRoot()`, never a hardcoded location.

**Enforced, not just documented.** [scripts/check-portability.ts](scripts/check-portability.ts) scans committable source for host-specific tokens (a consumer's bin abbreviation, business name, submodule paths, dbt marts, skills, and `BP_`-style env prefixes) and fails on any hit. It runs as `bun run check:portability`, as the CI-gating [tests/unit/portability.test.ts](tests/unit/portability.test.ts), and (host-side) in the embedding monorepo's pre-commit hook. Env vars are the sneakiest leak: read every coord var through `coordEnv()` (which prepends `HARNERY_`), never a bare `process.env.BP_*`. Escape hatch for a genuine non-host use: `portability-allow: <reason>` on the line (rare — prefer a neutral token).

**Bin name in agent-facing strings.** Any user-facing string that tells an agent to run a command (council prompts, end-of-turn nudges, command help/errors) must use `resolveBinName()` from [src/core/config.ts](src/core/config.ts), never a literal bin name. Commands can see the live program name, but the coord binaries (`agent-hook`/`agent-coord`) and the web UI run *as harnery* and can't, so the bin name is read back from `.harnery/config.jsonc` (`binName`). Resolution precedence: `HARNERY_BIN` env → config `binName` → `"harn"`. `harn init` stamps `binName` for a consumer (any bin ≠ `harn`); a host CLI commits its own `.harnery/config.jsonc` carrying its bin name.

## Public artifacts are source-neutral

Everything committed to Harnery is public, including its Git history. Keep internal evaluation sources, links, and quotations in the private host workspace. Public writing should state Harnery's problem, alternatives, decision, and evidence in Harnery's own terms. Do not say that a feature came from or was modeled after an evaluation source. This rule covers code comments, tests, docs, ADRs, changesets, commit messages, pull requests, release notes, and website copy.

**Enforced across content and history.** [scripts/check-public-surface.ts](scripts/check-public-surface.ts) scans the full public tree, commit messages, and every changed-file snapshot in an outgoing Git range. Harnery stores only opaque fingerprints, so the guard does not reveal the private source inventory. A `public-surface-allow: <reason>` waiver covers generic attribution language for a legitimate public standard or dependency. It cannot waive a restricted identifier. If a restricted identifier becomes a real public dependency, change its classification in the private host and regenerate the fingerprints. Do not bypass the guard.

## Surface tiers (ADR 0010)

The `package.json` exports map is the public-API tier boundary. **Product tier** — `.`, `./commander`, `./core/*`: the coordination layer, the reason the package exists, full semver care. **Toolkit tier** — every `./lib/*` subpath: supporting utilities for embedding hosts (http, cookies, format, readability, browser, machine, …), supported but secondary, allowed to evolve faster, never the pitch. Anything unexported is internal regardless of directory — `src/lib/` legitimately hosts unexported coordination libs (council, decision, identities); the directory is NOT the boundary, the exports map is.

Two rules follow, both enforced:

1. **Layering:** no `./lib/*` export may reach `src/core/`, directly or transitively. [scripts/check-layering.ts](scripts/check-layering.ts) walks each toolkit export's import graph and fails on any core path; [tests/unit/layering.test.ts](tests/unit/layering.test.ts) gates CI. No per-line waiver exists — a toolkit module that needs the core gets its export moved under `./core/*` (that's how `./lib/scratch` became `./core/scratch`). Product importing toolkit is fine; only the upward direction is forbidden.
2. **Promotion:** utilities are born in the host CLI and get promoted into the toolkit only when a second consumer needs them or harnery's own commands do. Never add a `./lib/*` export speculatively.

When writing README/docs/marketing copy, coordination leads and the toolkit is framed as batteries for embedders. Full rationale: [docs/src/content/docs/decisions/0010-surface-tiers.mdx](docs/src/content/docs/decisions/0010-surface-tiers.mdx); user-facing story: [docs/src/content/docs/concepts/embedding.mdx](docs/src/content/docs/concepts/embedding.mdx).

## Layout

- `src/commands/`: portable CLI commands (Commander pattern). New-command recipe: [CONTRIBUTING.md](CONTRIBUTING.md) § Adding a new command (register fn → wire in `src/commander.ts` → test → docs `.mdx` → changeset).
- `src/core/`: coord layer (agents state, session events, hooks, scratch).
- `src/lib/`: shared libs — a mix of exported toolkit modules and unexported internals (see Surface tiers above). Notables: `lib/council/` (council state machine: `writePrompt` auto-prepends the `<!-- council-route -->` header and auto-appends the `<!-- council-submit-footer -->` block, both idempotent; never hand-write those markers) and `lib/docs-lint.ts` / `docs-sweep.ts` (powers `harn docs`).
- `bin/`: `harn`, `agent-coord`, `agent-hook` entrypoints.
- `relay/`: the presence relay's Cloudflare Workers host (`relay/worker/`, deployed with wrangler; ADR 0016). The Bun self-host lives in `src/commands/relay.ts`; the shared wire protocol in `src/core/presence/relay-protocol.ts`.
- `web/`: standalone Next.js dashboard (private, not published). Booted by `harn web up`; port via `HARNERY_WEB_PORT` (default 9000).
- `docs/`: Astro Starlight site (harnery.com). Every new CLI command gets a `docs/src/content/docs/cli/<name>.mdx` page; ADRs live in `docs/src/content/docs/decisions/` (not a `docs/decisions.md`).
- `tests/`: `unit/`, `integration/` (`tests/integration/run.sh`), plus `*.test.ts` alongside source.

## Dev loop

```bash
bun install
bun test                 # unit + alongside-source tests
bun run test:integration
bun run typecheck        # tsc --noEmit (strict mode)
bun run lint             # Biome over src/ (check + assists, read-only)
bun run lint:fix         # auto-fix lint AND import-sort/assists (`format` only fixes whitespace)
bun run build            # tsc -> dist/ (JS + .d.ts) for the Node target; prepublishOnly runs this
bun run docs:dev         # Starlight docs site
bin/harn --help
```

## Runtime: Bun for dev, Node for ship

Bun runs the TS source directly (zero build), which is the dev loop and how an embedding host resolves `harnery/*` (the `exports` map's `bun` condition points at `src/*.ts`, so **keep it first**). The published package ships a built `dist/` and resolves there on Node/npm, so a plain `npm install harnery` runs with no Bun. `bun run build` (= `tsc -p tsconfig.build.json` + `scripts/rewrite-dts-extensions.mjs`, which rewrites the type-position `.ts` specifiers `tsc` leaves in `.d.ts`) produces it; `dist/` is gitignored. Internal `src/` code uses **relative** imports (with `.ts` extensions), never a self-import via the `harnery/*` package name, which only resolves under Bun. Shared code stays on `node:*` APIs so it runs on both runtimes; the lone Bun-only surface is `harn tunnel`'s `Bun.serve` gate worker, which fails fast with a clear message on a Bun-free host.

## Repo conventions

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/) (`feat:` / `fix:` / `chore:` / `docs:` / `test:` / `refactor:`), subject < 70 chars.
- **Changesets:** any change to published behavior (`src/`, `bin/`, `schemas/`) ships with a changeset (`bun x changeset`) so the release flow can version + publish. `web/` and `docs/` are unpublished, so no changeset.
- **Lint/format:** Biome, not ESLint/Prettier.

## Web app (`web/`)

Next 16 App Router + React 19 + Tailwind v4 (geist font, lucide icons). `next dev --webpack`, not Turbopack. House rules:

- **RSC-first.** Pages are server components reading `.harnery/` via `fs` per request; `"use client"` only at interactive leaves.
- **Writes prefer the CLI.** Council mutations shell `bin/agent-coord` / `bin/harn` (`web/lib/council-writer.ts`). Direct fs writes are reserved for operator escape hatches (`web/lib/coord-writer.ts`: release claim, ping, end session; deliberately no flock since they're operator-initiated and low-frequency). New write paths default to shelling the CLI.
- **Liveness:** ride the shared `useLiveSignal` hook (SSE with poll fallback; Cloudflare quick tunnels buffer SSE, so never EventSource-only) and the globally-mounted `LiveRefresher` (`router.refresh()` on coord-layer change). Don't roll new polling.
- **Colour grammar** for state UI: sky = act now, neutral = wait, emerald = done, `live-dot` pulse = agent working live. Reuse it; don't invent new state colours.
- **Agent names:** every rendered agent name goes through `AgentChip` (hover card with plain-text fallback), never a bare `agent-Foo` string.
- **Hover hints:** use `ui/tooltip`'s `<Tooltip content={…}>`, or the `title`/`tooltip` props on `Badge`/`Button`, which wrap it. Never the native `title` attribute (inconsistent chrome, invisible on touch). Note: React delegates `onMouseEnter` via `mouseover`, so synthetic-event tests must dispatch `mouseover`, not `mouseenter`.
- **Operator attention:** when a page state waits on the HUMAN (copy a council prompt, advance a round), mount `<Attention request={{ key, label }} />` (`components/Attention.tsx`). The root `AttentionProvider` drives title-flash / favicon-badge / chime / viewport edge-pulse / cursor→target flow lines, silences on deliberate interaction only (click/tap, or a keystroke while a form field is focused — scroll and stray keys never ack), and dedupes by `key` in sessionStorage. Suppress the request (pass `null`) while the responsible agent is live-working. Flow lines aim at `[data-attention-target]` markers, falling back to `.attention-ring` spotlights; tag the actionable element when a state has no ring. The NavBar bell (`[data-attention-replay]`, ack-exempt) replays the last alert. Don't roll bespoke title or audio alerts. The default favicon is `app/icon.svg`; the alert badge draws over it and restores it on ack (never remove the icon link, since browsers keep painting the last favicon).
- **JSX whitespace trap:** a text segment that follows a `{expr}` with a same-line space and contains an HTML entity (`&apos;`, `&lt;`, …) anywhere in the segment, including continuation lines, loses that leading space at compile time (the "round 2once" bug; bitten three times). Render such phrases as a single template-literal expression (no entities needed in JS strings). Enforced: `web/scripts/check-jsx-entity-whitespace.ts`, run by the host repo's pre-commit on staged `web/**/*.tsx`.

## Embedding in a host monorepo

harnery can be developed standalone or embedded in a host monorepo as a **git submodule** (commonly at `harnery/`). When embedded, commits to harnery land in *this* repo (Conventional Commits, per above) and the superproject tracks a gitlink, so commit and push here first, then bump the pointer in the host. A host that uses Bun workspaces can symlink its `node_modules/harnery` at the submodule path, so the same checkout serves both the submodule and the host's imports.

### Branch model

`main` is the released, CI-verified line. Day-to-day work lands on `next`, the long-lived integration branch; CI and the Release workflow only run on `main`, so commits to `next` are quiet, and a release happens when `next` merges to `main` (with a changeset present). Active development from a host therefore happens on `next`, and the host's superproject pointer tracks a `next` commit until a release is cut.

When more than one host checks out harnery (e.g. two separate monorepos each carrying it as a submodule), every checkout is an **independent clone of the same remote branch**. The single rule that keeps them from diverging: **pull before you edit, push immediately after.** Before touching harnery in any host, run `git -C harnery pull --ff-only`; after committing, push right away, then bump that host's pointer. Whoever pushes second without pulling first gets a non-fast-forward rejection.

This `AGENTS.md` is the canonical instructions file; `CLAUDE.md` is a verbatim mirror for Claude Code. Edit `AGENTS.md`, then copy it across.

<!-- harnery:begin instructions v=019fd432 -->
## harnery coordination

This project runs [harnery](https://harnery.com) for multi-agent coordination.
You share this checkout with other agents; the surfaces below keep you oriented
and out of each other's way. Run `harn <command> --help` for any command's full
surface. Procedures for the deeper flows live in the `harn-decide` and `harn-council` skills.

**Identity + peers.** You are one of several agents in this repo.
`harn agents whoami` is you; `harn agents status` shows your session plus the
active peers and the files they've claimed; `harn agents set-task "<focus>"`
declares your current focus so peers can see it. Check for peers before editing
widely-shared files.

**Durable role handoff.** When you are replacing a prior session in the same
named role, run `harn agents identity assume <name>` before declaring your task.
It reclaims an abandoned namesake (no live process) and refuses only when another
live process still holds the name; never hand-edit Harnery's history, heartbeat,
or derived identity cache.

**Declare intent on shell commands.** Every command you run is captured to the
coordination ledger. Lead a shell command with a `# intent: <why>` comment (or set
the tool's description) so the recorded event carries a reason instead of
`(no intent)`.

**Scratch journal.** `harn scratch add <category> "<text>"` (category = note, plan, decision, blocker, question, done, or handoff)
leaves breadcrumbs that survive context compaction;
`harn scratch read` reads yours, `harn scratch read --name <peer>` reads a peer's.
Use it for anything future-you or a peer will need to pick up your thread.

**Decision docket.** When you would otherwise stop to ask a human a decision you
can't resolve from the repo, file it instead. `harn decision file "<question>"`
records it and lets you proceed on a stated default; `harn decision search "<terms>"`
surfaces prior decisions, so check for precedent before re-deciding. The `harn-decide` skill has the file / claim / resolve-with-evidence procedure.

**Councils.** For a hard or contested decision, convene a council of agents.
`harn council create "<objective>"` runs structured rounds toward a decision. The `harn-council` skill has the steward and member flow.
<!-- harnery:end instructions -->
