# Changelog

## 0.21.0

### Minor Changes

- f4e973f: Expose each durable work assignment to reusable workflow scripts as frozen typed context, with the exact value preserved in run manifests and proof packets.

## 0.20.0

### Minor Changes

- 88f44a8: Add durable operator-guided recovery for the latest supervisor plan in attention. Preserve the original request, proposal, review receipt, and attention event while an addressed, idempotent retry event authorizes one new planner attempt under the frozen graph and cumulative budgets.

## 0.19.1

### Patch Changes

- 93b1247: Retry malformed supervisor completion, attention, milestone, and reviewer receipt shapes inside the bounded schema-correction loop instead of consuming a full replan or moving a plan directly to attention. Keep the proposed-root key namespace explicit throughout review and revision so reviewers do not confuse it with the existing active work ID.

## 0.19.0

### Minor Changes

- 6087db7: Add rendered alignment, gap, clipping, target-size, and sibling-overlap checks to `browse`, with structured outcomes, screenshot annotations, and fail gates that run together in one browser state.
- 2964e43: Add independent, bounded milestone-plan review with deterministic revision, durable receipts, CLI and dashboard rendering, public read APIs, and supervisor recovery.

## 0.18.0

### Minor Changes

- e94966b: Add objective-first supervisor missions with reviewed initial plans, immutable milestone generations, boundary reassessment, and explicit mission-completion decisions.

## 0.17.0

### Minor Changes

- ad7a561: Add bounded dynamic replanning with frozen workflow templates, schema-gated planner proposals, explicit review by default, append-only graph generations, restartable plan approval, and goal-wide budgets that include superseded work.

## 0.16.0

### Minor Changes

- 65ec4ef: Add an optional background supervisor service with explicit goal enrollment, durable wake state, live heartbeat and status, graceful stop/restart, quiescence while goals await external change, and persisted exponential backoff for service-level errors.

## 0.15.0

### Minor Changes

- 0ca6445: Add a durable goal supervisor that freezes specialist profiles and bounded automation policy around a root durable-work dependency graph. The new `harn supervisor` CLI and `harnery/core/supervisor` export can run one scheduling tick or continue foreground cycles until accepted success, attention, no progress, or budget exhaustion, while workflow specialist instructions and defaults remain frozen across approval resume.

## 0.14.0

### Minor Changes

- ea47a1d: Add a durable work ledger and one-shot reconciler above workflow attempts. Work items preserve immutable objectives, dependencies, bounded attempt history, approval parking, proof-derived review, and explicit acceptance across process restarts. The new `harn work` CLI, `harnery/core/work` export, workflow backlinks, and dashboard views expose the same reconstructable local state without silently starting, retrying, or completing work.

## 0.13.0

### Minor Changes

- 54c3a95: Add a durable workflow approval inbox with idempotent decisions, honest parked runs, script-drift protection, same-run cached resume, CLI controls, journal receipts, and dashboard visibility.

## 0.12.2

### Patch Changes

- 939a90b: Prove that coordination and scratch filenames resolve directly beneath their trusted roots before any filesystem access.

## 0.12.1

### Patch Changes

- 6b4ca9c: Harden coordination file boundaries, email HTML conversion, browser selector evaluation, and scratch parsing; refresh vulnerable documentation and runtime dependencies.

## 0.12.0

### Minor Changes

- c02f54d: Add a host-enforced workflow policy seam with fail-closed dispatch and external-mutation decisions, cost and capability constraints, approval callbacks, CLI inspection, and proof-packet receipts.

## 0.11.0

### Minor Changes

- 03922e9: Add proof-bearing workflow runs with objectives, acceptance criteria, typed
  evidence receipts, terminal proof packets, a proof inspection command, and the
  public `harnery/core/workflow` API.

### Patch Changes

- 8edc237: Align the declared Node runtime with production dependencies, retain Node 20
  support, refresh patched email parsing dependencies, and smoke-test the public
  workflow export from the packed package.

## 0.10.0

### Minor Changes

- 33fbeb6: Session-name suggestion for the operator's harness tab title, folded into the focus declaration.

  `harn agents set-task`, on the **first** focus declaration of a session (detected by the absence of a prior `task_updated_at` stamp), now returns `first_of_session: true` and a `suggested_session_name` (`Agent <you> - <task>`) alongside its usual payload — one declaration feeds both the peer-visible task and the tab name. The agent reproduces the name in a fenced code block so the chat UI's Copy button hands the operator the exact string. Every later `set-task` returns `first_of_session: false` and a null name.

  `harn agents suggest-name` becomes the read-only secondary path: reprint the current session's name or re-suggest after a topic pivot. Its description arg is now optional — with no arg it derives the name from the current task. Prints the bare name (no box); `--json` for the structured form; `--session-id <id>` bypasses the ppid walk like `status`/`set-task`.

- ffad863: Browser diagnostics now record HTTP-level request failures: `FailedRequest` gains `status`, `kind` ("http" | "network"), and `document` fields, and the browser client captures responses with status >= 400 alongside the existing network-failure events. Previously a script or stylesheet answered with a 4xx/5xx was invisible to `failedRequests`-based gates (only never-completed requests were recorded). Consumers that count `failedRequests` may see new entries on pages with failing subresources — that is the defect being surfaced.
- 8a60121: New `harn claude-desktop` command: make Claude desktop-app sessions survive account switches.

  The Claude desktop app scopes its Claude Code session sidebar per signed-in account (plain JSON entry files under `<dataDir>/claude-code-sessions/<account-uuid>/<env-id>/`), so switching accounts — the usual move when one account hits its usage limit — hides every prior session even though the transcripts remain on disk. `harn claude-desktop accounts` / `sessions` enumerate the per-account indexes (auto-locating the data dir on macOS/Windows/Linux, including Windows-side discovery from inside WSL; labels the CLI's own account via `~/.claude.json`), and `harn claude-desktop mirror` copies entry files across account directories so each account's sidebar lists the union. Mirror is dry-run by default (`--yes` applies), idempotent (dedup by `cliSessionId`), skips archived entries unless `--include-archived`, selects with repeatable `--session <id-or-title>` / `--all`, and scopes direction with `--to` / `--from` uuid prefixes. Restart the desktop app to pick up mirrored entries.

- 80aa34c: Honor the `coord`, `backup`, and `sync` config sections from `config.jsonc`, and add a user-global config layer.

  Previously these sections were declared in the published JSON schema but the config reader never read them — freshness was env-only, `harn backup`/`harn sync` were env-and-separate-file only. Now:

  - **User-global layer**: `~/.config/harnery/config.jsonc` (honors `XDG_CONFIG_HOME`) is read as a base and merged **project-over-user**, field by field. The `binName` pin that `harn init` guards stays project-file-only.
  - **`coord.freshness_seconds`** drives the heartbeat sweep window and the `agents` freshness cutoff (env `HARNERY_AGENT_COORD_FRESHNESS`, alias `HARNERY_AGENT_FRESHNESS`, still override). This also unifies three previously-divergent reads (a hardcoded `600`, `AGENT_FRESHNESS`, and `AGENT_COORD_FRESHNESS`) onto one accessor.
  - **`backup.{repo,password_file,keep_daily,keep_weekly,keep_monthly}`** set the restic defaults (env + `--keep-*` flags still override).
  - **`sync.{remote,prefix}`** set the rclone defaults (env still wins; `~/.config/harnery/sync.json` remains a lower-precedence fallback).

  Schema alignment: removed keys that described non-features (`coord.name_pool`, `backup.schedule`, `sync.enabled`, `sync.drive_folder`) and added the ones the code actually honors. A config that set one of the removed keys (all previously no-ops) now fails `$schema` validation.

- 01b6bc9: Add context telemetry, durable pre-compaction capsules, post-compaction recovery injection, canonical continuity events, and `harn context status|checkpoint|show`.
- 15c6b34: Cross-machine session presence (ADR 0016), phase 1: the git-refs transport. Each machine publishes its live sessions (names, tasks, files held) as a parentless commit force-pushed to `refs/harnery/presence/<machine>` on origin, and fetches peers' refs on a throttled hook cadence — zero configuration, repo access is the only credential. Remote sessions render in `agents list` (relation=remote rows with a `machine` field), the `agents status` peers line (`Name @machine`), and the SessionStart/prompt peer tables, advisory-only. New subcommands: `presence publish|fetch|peers`. Opt out via `.harnery/config.jsonc` `{"presence":{"enabled":false}}` or `HARNERY_PRESENCE=0`; everything is fail-silent (no origin / no network / refused refs → no remote peers, never a broken hook).
- db22895: Add `harn agents identity assume <name-or-id>` for durable role continuity across harness sessions. The command reuses or mints a persona UUID, refuses a live local or known remote namesake, appends an auditable latest-wins binding to `.name-history`, emits `identity.assumed`, and synchronously reprojects the heartbeat. Heartbeat healing, event replay, `agents trace`, and the web identity cache now preserve the assumed role; `.identity-index.json` remains derived and is never edited by the command.

  The injected coordination instructions now teach replacement sessions to use this command instead of editing state files. Re-run `harn init` in an existing project to refresh that managed block.

- 2aca874: Presence relay client transport (ADR 0016 phase 2c) + `harn relay serve` self-host. With `.harnery/config.jsonc` `{"presence":{"relay":"wss://…"}}` set, hooks lazy-start a per-machine daemon (`harn presence relay-daemon`) that holds the relay WebSocket: publishes the encrypted presence blob on every heartbeat change (fs.watch, 60s keepalive), caches received peer blobs at `.harnery/presence/remote/`, auto-reconnects with jittered backoff, and exits when the machine goes idle. `readRemoteMachines` (and every render surface on it) now merges both transports — git refs and relay cache — freshest per machine. `harn relay serve` runs the same wire protocol as the Cloudflare worker for self-hosters (Bun-only). Relay unreachable → silent degradation to the git-refs floor.
- 028d3df: Presence relay, phase 2 groundwork (ADR 0016): the shared relay wire protocol (`src/core/presence/relay-protocol.ts` — HKDF capability-room derivation from repo identity, AES-GCM E2E payload encryption, opaque HMAC sender ids, frame parsing/caps) and the Cloudflare Durable Objects relay host (`relay/worker/` — one DO per room, WebSocket Hibernation API, warm-join cache in DO storage, per-socket rate limits; deployable to any Cloudflare account with `wrangler deploy`, free-plan compatible). The reference public deployment runs at relay.harnery.com. Client transport (hooks → relay) ships next.
- 2b73aeb: Add a registered Claude/Codex/Cursor capability catalog, an offline drift-detecting conformance bench, and workflow effort mapping for Claude and Codex.

### Patch Changes

- 0507da7: Fix: `agents set-task` / `release-claim` / `stamp-status-call` / `heal` failed with "no heartbeat at .harnery/active/<id>.json" when the shell's cwd sat inside a nested directory carrying its own `.harnery/` (e.g. an embedded harnery checkout). The parent command resolves the coord root git-superproject-aware, but the spawned `agent-coord` helper re-resolved by walking up from the drifted cwd and hit the nested root. Every agent-coord spawn now pins the caller-resolved root via `HARNERY_COORD_ROOT_OVERRIDE` (the same contract the hooks side already used), and the no-heartbeat error names the fully-resolved path so a wrong root is instantly visible.
- f2cb5c1: Configurable Chromium launch flags for `browse`, plus a WSLg headed default. New `--browser-arg <flag>` (repeatable) and `HARNERY_BROWSER_ARGS` (whitespace-separated) pass arbitrary Chromium launch flags for environment-specific workarounds; `BrowserOptions` gains a `launchArgs?: string[]` passthrough, and `harnery/lib/browser` exports `isWSL()` + `wslHeadedLaunchArgs()` for embedding hosts that launch their own headed browsers. Under WSL, headed launches auto-add `--disable-gpu` (opt out with `HARNERY_BROWSER_NO_WSL_DEFAULTS=1`) to mitigate the common WSLg GPU-compositing blank-window mode — note that a blank headed window can ALSO mean WSLg's shared-memory pixel channel is dead (`rdp_allocate_shared_memory … Input/output error` in `/mnt/wslg/weston.log`), which no flag fixes; that needs `wsl --shutdown`. The browse docs cover distinguishing the two.
- 666af42: Fix: canonical emits silently vanished when the shell's cwd sat inside a nested directory carrying its own `.harnery/` (e.g. an embedded harnery checkout). `emitCanonical` resolved its root by walking up from cwd, hit the nested root, and built a `<root>/harnery/bin/agent-coord` path that doesn't exist — so `agents status` / `set-task` / scratch / presence / decision events were dropped without a trace, and the Stop-hook's rule 1/3 (`state.status_checked` in-turn) blocked turns that had performed the ritual. Root resolution is now git-superproject-aware (`monorepoRoot()`, with the cwd walk kept as a non-git fallback), the spawn pins `cwd` + `HARNERY_COORD_ROOT_OVERRIDE` to the resolved root (same contract as the coordHelperOpts root-pin fix), and a failed emit now warns on stderr instead of dying silently. `sessionEventsPath()` and `readLastIntent()` ride the same resolver, so middleware command events and intent stamps stop mis-anchoring to nested roots too.
- 5eee932: `eml --headers` now renders the source message's full headers. The flag was registered and documented but its value was never read (a silent no-op); it now emits a "Source headers" block from the parsed `.eml`. (A Gmail thread export is a single `.eml`, so there is one real header set — the prior "per message" wording was corrected.)
- 9095f15: Make `agents identity assume` reclaim abandoned local namesakes whose harness process is dead (or missing from pid-map), instead of refusing for the full freshness window. Still refuses when another live process or cached remote presence holds the name.

  Also skip Cursor sessionStart bootstrap in `ensureCursorSession` when `HARNERY_AGENT_COORD_OWNER` is already set, so whoami/assume fixtures under Cursor cannot wipe an assumed persona `agent_id`.

- 32bdbeb: docs-lint: allow LICENSE.md filenames (GitHub-recognized OSS file; also appears in vendored upstream trees where renaming damages provenance)
- 9cc3617: Documentation completeness for presence/relay: README feature bullet, coord-layer concepts section, config-schema reference (`presence` key), and the shipped `schemas/config.schema.json` now declares `tools`, `workflow`, `skills`, and `presence` (it uses `additionalProperties: false`, so editors were flagging valid configs carrying those keys).
- 4e77a68: The injected AGENTS.md coordination block now renders the scratch-journal category list from the canonical `SCRATCH_CATEGORIES` enum instead of a hardcoded prose list, which had silently drifted (it listed 5 of the 7 categories, omitting `question` and `done`). A test now locks the block to the full enum so it can't regress. Re-run `harn init` to pick up the corrected block (its version hash changes).
- 32b42e0: Fix the published JSON config schema (`schemas/config.schema.json`): `web.port` declared its default as `7777`, but `harn web up` actually defaults to `9000`. Editors reading the `$schema` were suggesting the wrong port.

## 0.9.0

### Minor Changes

- 8a13894: grep: NUL filename framing, materialized context, exact truncation, and file-level composition.

  New flags: `--and <pattern>` / `--without <pattern>` (file-level boolean composition, repeatable), `-A`/`-B` (per-side context overriding `-C`), `-q/--quiet` (exit 0/1 status, no output), and multi-value `--lang` (`--lang ts,tsx` or repeated). JSON envelope additions (additive): rows carry `kind: "match" | "context"`; the top level gains always-present `and_patterns`/`without_patterns` arrays.

  Corrections: `-C` context rows previously parsed as fake matches (garbled output, inflated `total_matches`/`total_files`, context consuming `--limit`) — context is now materialized from file reads after selection, with correct kinds, merged windows, and free context rows. Filenames are NUL-framed (`--null` on both engines), so colon/dash/space-bearing paths parse correctly. `truncated` is now exact: a search with exactly N results under `--limit N` no longer reports true. Invalid numeric flag values and meaningless flag combinations (context with `-l`/`-c`/`--files`/`-q`, composition with `--files`, quiet with `--json`/`-l`/`-c`/`--limit`) fail loudly before an engine spawns.

- 8967d2f: Hooks now survive the session shell `cd`-ing away from the project root.

  Harnesses spawn hook processes with the session shell's current working
  directory, which follows `cd` into subdirectories, submodules, or off-repo
  scratch dirs. Two failure modes stemmed from that:

  1. **Silent spawn failure.** `harn init` wired hook commands with a
     project-root-relative agent-hook path (`bash harnery/bin/agent-hook …`),
     so once the shell left the root the hook binary wasn't found and every
     hook died silently — no events, no image capture, no claim guards, until
     the shell happened to `cd` back. Claude Code commands are now anchored on
     the harness-provided project dir
     (`bash "${CLAUDE_PROJECT_DIR:-.}"/…/agent-hook …`); re-running `harn init`
     upgrades previously-wired stale commands in place (new `upgraded` counter).
  2. **Wrong coord root.** When the hook did spawn, `findCoordRoot` walked up
     from the drifted cwd and could land on a nested `.harnery/` (a submodule
     initialized with `harn init`) or none at all. The hooks-side resolver now
     prefers the harness project dir (`CLAUDE_PROJECT_DIR`) over the cwd walk;
     `HARNERY_COORD_ROOT_OVERRIDE` still wins over both. Child `agent-coord`
     spawns from the hook layer are pinned to the resolved root via
     `HARNERY_COORD_ROOT_OVERRIDE` so they can't re-resolve differently.

- 566ca6e: New `harn workflow run <script>`: bounded, schema-gated, conditionally-routed multi-subagent workflows. Scripts are plain JS (`export default async ({agent, parallel, stage, log}) => …`); subagents spawn as headless harness-CLI subprocesses and are coordination-registered — hooks stay on, with a new `stop-hook.workflow_child` exemption (`HARNERY_WORKFLOW_CHILD=1`) so headless children skip the human-facing end-of-turn ritual without losing heartbeat/event capture. Three spawn adapters, all live-verified end-to-end (codex against codex-cli 0.144.5; cursor against cursor-agent 2026.07.16, which requires the `--trust` flag headless), selectable via `--harness` or per-agent `opts.harness`. `--resume-from <run-id>` replays completed agent results from a prior run's journal (same call identity → cached, $0). The engine surfaces per-child context overhead up front (`contextTokensPerChildEstimate` + a run-start log line), and the web dashboard gains a journal-driven `/workflows` list + per-run stages→agents detail view. Runs journal to `.harnery/workflows/<run-id>/journal.jsonl`. Billing safeguards: children ride the logged-in (subscription) harness auth by default; a per-harness billing probe on first spawn refuses the silent-override state (an exported API key shadowing a stored login) unless `--allow-api-billing`, and `--subscription-only` (or the `workflow.subscriptionOnly` config pin / `HARNERY_WORKFLOW_SUBSCRIPTION_ONLY` env) scrubs every API-key var from child envs and fails loud on a provably-absent login. Fix: `CURSOR_API_KEY` is carved out of the `CURSOR*` session scrub (it's a credential; key-only cursor hosts previously lost it). `harn init` now pins `workflow.subscriptionOnly: true` into `.harnery/config.jsonc` for any project without a committed `workflow` key, so new setups are subscription-only out of the box (comment-preserving, idempotent, never touches a deliberate `workflow` config). `harn doctor` gains `workflow:claude-code|codex|cursor` checks (installed? authenticated? billing mode?), and a missing harness CLI now fails with the vendor's install one-liner + login command instead of a bare not-found. Design record: decision 0015.

### Patch Changes

- 5b05083: Claims actually release on commit now. The post-commit prune chain was broken
  in three compounding ways, so agents appeared to hold files long after
  shipping them:

  1. `groupUnclaim` (the post-commit / post-checkout prune) compared paths with
     an exact-string filter, but `files_touched` holds a mix of canonical
     repo-relative entries (written by the claim guard) and absolute paths
     (projected from raw Edit/Write tool_input) — the mixed-form case silently
     no-op'd. It now normalizes both sides, releases every form of the path in
     one pass, and reports which heartbeats actually dropped it.
  2. The prune was file-only: no `claim.release` event was emitted, so even a
     successful prune resurrected on the next projector replay.
     `agent-coord post-commit` / `post-checkout` now emit the durable event per
     actual removal (reasons `commit` / `checkout`), and the conflict-time
     stale-claim self-heal (`pruneClaimFromPeer`) got the same normalization +
     event treatment.
  3. The heartbeat projector stored the raw absolute tool_input path, so every
     guarded edit double-counted as two claims (relative + absolute). It now
     canonicalizes to repo-relative before storing.

## 0.8.0

### Minor Changes

- 229f497: `harn grep` is now ripgrep-backed and searches repos in parallel. When `rg` is
  on PATH it is used automatically (GNU `grep` remains the transparent fallback;
  `HARNERY_GREP_ENGINE=rg|grep` forces one), driven with equivalent flags so
  results are identical across engines — pinned by a new engine-parity test
  suite, with `scripts/bench-grep.ts` to reproduce the numbers. On a real
  24-repo monorepo the search phase of an `--all-repos` sweep dropped 863ms →
  147ms (warm cache; the gap widens cold), and the sweep's end-to-end wall time
  dropped ~6.8s → ~1.1s.

  Correctness and output changes that ride along:

  - `--all-repos` no longer double-scans and double-reports submodule matches:
    the parent scan prunes submodule directories, so each match is attributed to
    exactly one repo (a previous sweep returning 90 rows now returns the 56
    unique ones).
  - Matches are sorted (file, then line) for stable cross-run, cross-engine
    output; engine order is kept in `-C` context mode so groups stay adjacent.
  - `-c` no longer emits `path:0` rows for match-less files (GNU grep prints
    them; ripgrep doesn't — the envelope now filters them on both engines).
  - Leading `./` is stripped from file paths.
  - Partial failures (an unreadable file mid-walk) return collected matches
    instead of throwing everything away.
  - New `HarneryProgramContext.grepExcludeDirs` lets a host CLI add its
    generated-mirror directories to the default skip list.
  - The JSON envelope gains an `engine` field.
  - New `--files` mode: treat `<pattern>` as a filename glob and list matching
    files (`rg --files` when available, POSIX `find` fallback; same excludes,
    scoping, `-i`, `--exclude`, and `--limit`; content-search flags are
    rejected).
  - Fixed rg glob ordering: positive globs (`--include`, `--lang`, the `--files`
    pattern) are now emitted before negative excludes, so an exclude always wins
    (rg globs are last-match-wins; previously `--include '*.md'` could
    re-include files inside an excluded directory).
  - harnery can now provision ripgrep itself: a version-pinned, sha256-verified
    download into `~/.local/share/harnery/tools`, probed by `grep` directly (no
    PATH edit). `doctor --fix` installs on demand; committing
    `{ "tools": { "ripgrep": { "autoInstall": true } } }` in
    `.harnery/config.jsonc` makes the first `grep` on an rg-less machine
    self-provision. Without consent, a once-per-day stderr hint names the fix;
    every failure path (offline, checksum mismatch, unsupported OS/arch) falls
    back to GNU grep. `doctor` gains a `ripgrep` check row; `HARNERY_RG_PATH`
    overrides the binary, `HARNERY_TOOLS_AUTOINSTALL=1|0` overrides consent.

### Patch Changes

- b1d2fb2: `harn callers` now shares the ripgrep engine + provisioning path with
  `harn grep` (ripgrep when available, GNU grep fallback, `HARNERY_GREP_ENGINE`
  override, managed-install consent) and searches repos in parallel. Fixes the
  same double-scan bug grep had: in `--all-repos` mode the parent scan now
  prunes submodule directories, so each match is attributed to exactly one repo
  instead of being reported under both parent and submodule. Engine parity is
  pinned by a new test suite.

## 0.7.1

### Patch Changes

- 83de3ed: Claim releases are now stream-durable. `agent-coord release-claim` and
  `kill-heartbeat` mutated only the live heartbeat file and emitted no event, so
  the heartbeat projector — which rebuilds `files_touched` by replaying the
  permanent `Edit`/`Write` events — silently reverted every release on the next
  full replay (a lagging-cursor `replayAll` drain): released claims returned
  within seconds, and a killed heartbeat resurrected with all its claims. Both
  handlers now append a canonical `claim.release` event (reason `explicit` for a
  release, `heal` per held path on a kill) so every future replay subtracts the
  path too; the projector's `claim.release` case additionally normalizes
  absolute-under-coordRoot vs repo-relative path forms before comparing (the
  exact-string filter no-op'd on the mismatch). Idempotent re-releases of a path
  not held stay quiet. Every release surface inherits the fix — `agents
release-claim`, the web UI release button, the hooks' auto-release-on-failure,
  and `agents heal --kind kill`.

## 0.7.0

### Minor Changes

- 0bc7b77: `harn init` now ships the agent-facing layer, not just hooks. It splices a machine-owned, hash-versioned instructions block into `AGENTS.md` and writes the generic `harn-decide` + `harn-council` skills (claude-code), so a fresh consumer's agent knows the decision docket and councils exist. `harn deinit` removes both (a hand-edited skill is left with a warning, never clobbered), and `harn init --check` reports drift without writing (exit 0 fresh / 2 drift / 1 error) for pre-commit / CI. A `CLAUDE.md` `@AGENTS.md` import shim is created when `CLAUDE.md` is absent; one that already reaches `AGENTS.md` is left alone. Suppress a shipped skill you replace with your own via `skills.exclude` in `.harnery/config.jsonc`; the injected block is exclusion-aware, so it points at `<bin> decision --help` / `<bin> council --help` instead of a skill it didn't write (also true for cursor/codex, which get the block but no skill files). Design: ADR 0008.
- 81afb5b: Add `harn devtools`: a status reader for the three AI coding agents Harnery supports — Claude Code, Codex, and Cursor. Reports logged-in status, plan / seat tier, auth expiry, session counts, and rate-limit / quota windows with reset timestamps, in one uniform `ToolStatus` shape. The default report reads files on disk only — no network; auth tokens are inspected for their non-secret claims (email, plan, expiry) and never read into the output. `--usage` adds an opt-in, mtime-windowed scan of local transcripts for approximate token totals.

  Opt-in network enrichments (all skipped by `--no-api`, cached two minutes under `~/.cache/harnery/devtools/`) fill the live signals each tool keeps server-side, authenticating with the credential already on disk:

  - **Claude Code** reads the OAuth token from `~/.claude/.credentials.json` and calls `api.anthropic.com/api/oauth/usage` (the endpoint `/usage` uses) for the 5h + weekly rate-limit windows and extra-usage spend. That endpoint is sharply rate-limited and shared with Claude Code's own usage panel, so the result is cached and a rate-limited fetch degrades to a note without being cached.
  - **Cursor** reads the IDE session token from `state.vscdb` and calls cursor.com's dashboard API (the Spending-page request) for the billing cycle + total/API/first-party percent-used + on-demand spend. No API key needed.
  - **Cursor Cloud Agents** — when a Cursor API key is stored, adds Cloud Agent activity from the public `/v0` API (individual Cursor plans expose no usage/spend there).

  `ToolStatus` gains `usage` (Cursor billing) and a shared `spend` (Claude extra-usage / Cursor on-demand overage); `quota[]` is now populated live for Claude Code as well as Codex.

  The network enrichment is disciplined to protect these shared endpoints: results are cached per account (keyed by a token fingerprint) for five minutes, so the dashboard touches the network at most once per tool per five minutes no matter how often it re-renders, and switching accounts shows the new account's numbers immediately; a 429 arms a `Retry-After` cooldown that suppresses further calls (serving last-known-good) so a rate limit can't cascade; and every request carries the tool's own client identity with a live version — `claude-cli/<version> (external, cli)` + `x-app: cli` for Claude (version read from the newest session transcript), Cursor's Electron UA embedding the `state.vscdb` version — so it reads as first-party traffic. `harn devtools doctor` makes one cache-bypassing call per endpoint to detect header/schema drift (`auth_rejected` / `shape_changed`), reported distinctly from a rate limit.

  Codex is read from local files only and is multi-install aware: when a machine has more than one Codex install (e.g. a WSL CLI and the Windows desktop app, each its own account), the reader locks onto the active install (whichever owns the freshest rollout) and reads auth + rate limits from it, so accounts never mix. Auth expiry is reported from the access token (which outlives the id token), so a healthy login is no longer shown as expired. There is deliberately no network enrichment for Codex: OpenAI returns its rate-limit state inside the stream of an actual model turn rather than from a standalone usage endpoint, so the rollout on disk already holds the authoritative server snapshot and refreshing it would cost a model turn — the local read is strictly better, and its freshness equals the last-active time. A `rate_limit_reached_type` in the snapshot surfaces as a throttle note. Codex's token total is shown on the card unconditionally over the `--window-days` window (default 7): each session's cumulative `total_token_usage` is the last `token_count` event in its rollout, so the total is one bounded tail-read per in-window rollout rather than a full parse, cheap enough for every render.

  Claude Code's token total is likewise always on the card, over the same window. A Claude transcript has no per-session cumulative field, so the total is the sum of every message (hundreds of MB of transcripts in a busy week); to keep that off the hot render path it is memoized per transcript at `~/.cache/harnery/devtools/claude-tokens.json`, keyed by path + mtime + size, so after the first scan only changed transcripts (usually just the live session) are re-read. `--usage` forces a fresh, cache-bypassing recount. Large token counts render compactly on the card (`4.9M`, `13.8B`) with the exact value on hover; the figure includes cache-read tokens, so it runs far above the billed-token count.

- 6f2fda7: Add a shared YAML-frontmatter parser for lifecycle docs (`src/lib/docs-frontmatter.ts`). `parseFrontmatter` splits a leading `---` block (tolerating BOM/CRLF, never throwing on bad YAML, using `JSON_SCHEMA` so dates stay strings). `readDocStatus`/`readDocStatusFromText` dual-read status — preferring YAML `status:` and falling back to the legacy `**Status:**` bold line — with `normalizeStatus` collapsing token variants (`in_progress`/`WIP` → `in-progress`, done-family → `shipped` for plans or `resolved` for issues/handoffs, `wont-fix` → `wontfix`) and trailing-note stripping. The docs lint, sweep, and index commands now use the shared reader, so hosts can migrate files incrementally without losing lifecycle checks. New `docs meta <path> [key]` and dry-run-first `docs frontmatter-migrate` subcommands expose the metadata contract and convert lifecycle corpora without guessing at unsupported values.
- 7020ac5: `harn env` sections are now host-extensible, and harnery core no longer ships provider-specific checks. Core previously carried built-in `gcp` and `bq` (Google Cloud / BigQuery) connectivity sections, which is opinionated cloud coupling for a generic tool. Core now ships only the generic sections (`runtimes`, `docker`, `git`); an embedding host registers its own via the new `context.envSections` (a `Record<string, EnvSection>` on `HarneryProgramContext`, with exported `EnvSection` / `EnvCheck` types). Host sections merge in after the generic ones, so `harn env <name>` and the full report pick them up automatically. Standalone `harn env` no longer has `gcp`/`bq`; a host that wants them registers them.
- 2ef36a0: The canonical event ledger `.harnery/events.ndjson` now rotates by size instead of growing without bound. Both append paths (agent-hooks and agent-coord) roll the active file to a dated `events-YYYY-MM-DD.ndjson` archive once it crosses a byte cap (`HARNERY_EVENTS_ROLL_BYTES`, default 256 MiB), under an `O_EXCL` roll-lock so concurrent appenders never double-rename. Archives are kept, so the immutable audit trail is preserved. Readers span the boundary transparently: `scanEventsTail` continues from the active file into archives newest-first, and the web identity index folds each archive exactly once so agent names survive a roll. This removes the failure class where a reader that whole-file-read the ledger crashed on V8's ~512MB max string length once it grew large enough. Design: ADR 0009.
- b5368c8: `harnery/lib/http` gains `requestWithRetries()` + `backoffDelayMs()` — the retrying JSON-API primitive (per-attempt timeout, retry on 429/5xx with exponential backoff + jitter, Retry-After honored when sane, injectable retry policy / observability hook / network-error factory). Terminal non-2xx responses return `ok: false` so callers keep their own error taxonomies. Extracted from ten near-identical vendor-client copies in the first embedding host (toolkit-tier promotion per ADR 0010's demonstrated-reuse rule; a tokenCache abstraction was deliberately NOT added — no second consumer yet).
- 5af2319: Declare the two-tier public surface (ADR 0010): product tier (`.`, `./commander`, `./core/*` — the coordination layer) vs toolkit tier (`./lib/*` — supporting utilities for embedding hosts). BREAKING (pre-1.0): the `./lib/scratch` export is now `./core/scratch` — scratchpads are a coordination feature, and the source moved to `src/core/scratch/` accordingly. A new CI layering guard (`scripts/check-layering.ts`) enforces that no `./lib/*` export imports the coordination core, directly or transitively. README, package description, and docs now lead with coordination; the toolkit is documented as batteries for embedders (see the new "Embedding + surface tiers" concepts page).

  Also fixed: `init` now honors a `binName` already pinned in `.harnery/config.jsonc` instead of re-stamping the invoking CLI's name over it (`pinnedBinName()`), and the portability scanner covers the agent-facing surfaces (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.harnery/config.jsonc`) so a host bin name can't silently land in committed files.

- d23ce62: Require lifecycle status in leading YAML frontmatter across `docs lint`, `docs sweep`, and `docs index`. Legacy `**Status:**` lines are no longer read by those consumers; `docs frontmatter-migrate` remains available as the explicit one-shot conversion path. Lint now checks plans, issues, handoffs, and archived plans, and reports missing YAML status as an error.

### Patch Changes

- 63b575b: `harn agents show`: correct the command help. It advertised "claude-sessions history (latest title, recent prompts, recent tools, tool-usage tallies)", but standalone harnery never returns that data (the per-peer enrichment is a documented future `context.peerReport` seam that stays null). The help now describes what the command actually reports: registry state (files held, last tool, task, turn summary).
- a3fffc5: Fix Cursor Glass agent identity resolution. `harn agents whoami/status/set-task` now recognizes `CURSOR_CONVERSATION_ID`, prefers per-chat session-env identity over Cursor's shared node pid-map row, and lazily bootstraps a missing Cursor heartbeat from the first agents CLI call.
- 9c6054d: `harn docs sweep` no longer spawns one `git log` per markdown file. Ages come from a single `git log --name-only` per repo, which drops a large-monorepo sweep from about a minute to under a couple of seconds and stops the command looking hung when piped.
- ad026ff: Update Codex hook wiring for its strict native schema, migrate obsolete lifecycle entries, and report invalid Codex hook configuration through `harn doctor`.
- d386204: fix(agents): arm the claim-ordering rule only on genuine cross-agent contention

  The ordering rule (acquire file claims in sorted-path order to prevent a
  circular wait) previously armed whenever ANY fresh peer held ANY claim, so a
  peer editing completely unrelated files across the repo walled off every
  backward-order edit an agent tried to make. That was the dominant real-world
  cost of the rule: it fired almost never on a genuine deadlock but forced agents
  into awkward subprocess/heredoc write workarounds all session long — workarounds
  that are themselves uncoordinated, defeating the guard's purpose.

  A wait-for cycle is a strongly-connected set of agents linked by shared files.
  If no fresh peer shares any file with our footprint (held claims ∪ the path
  being requested), we sit in a disjoint component of the resource graph and
  cannot be part of any cycle, so sorted-order acquisition buys nothing. The rule
  now arms only when a fresh peer's held set intersects that footprint. Sharing a
  file is the necessary condition for a cycle through this agent, so the
  deadlock-prevention invariant is unchanged for genuine contention; only the
  false positives (an unrelated peer arming the rule) are removed.

  This is the fourth narrowing of the same rule, following committed-clean
  exemption (0b4ed15), out-of-repo skip (1b130a9), and the re-edit exemption
  (e41fb65).

- b6c8654: Core hooks no longer hardcode a host-specific `claude-sessions sync` command. The Claude Code turn-stop / session-end effect that synced session telemetry named a command that only the embedding host provides, so a plain public install spawned a doomed (best-effort, ignored) process every turn. Core now fires an optional host extension script at `scripts/hooks/harness/claude_code/extensions/session-sync.sh` under the coord root instead (the same pattern `runTurnSummary` already uses), passing a force flag as argv. A host that wants session telemetry drops that script in; a plain install spawns nothing. Keeps `src/core/` free of host command names.
- 966c7f4: Add Tailscale as a selectable tunnel provider. `harn tunnel up --provider tailscale` now exposes the existing Host-rewriting gate through Tailscale Serve by default, with `--visibility public` switching to Tailscale Funnel, while the existing Cloudflare quick tunnel remains the default provider.

  Resolve the MagicDNS URL before starting the Tailscale share so an unresolvable name fails cleanly instead of leaving a live, stateless exposure, and warn on `tunnel down` when the `serve`/`funnel off` teardown fails so a surviving mapping can't silently keep the machine exposed.

## 0.6.0

### Minor Changes

- f4fc810: `harn browse --check-runts [selector]`: detect runts (a single word alone on a text block's last visual line) by counting words per line via per-word Range rects. Reports hits in the JSON envelope under `runts`, annotates them on the screenshot, and `--check-runts-fail` exits non-zero on any hit. Also fixes the `--no-check-visible-annotate` / `--no-check-width-annotate` / `--no-check-overflow-annotate` opt-outs, which read the wrong Commander attribute and never disabled annotation.
- f4fc810: Add `harn decision`: a decision docket — a persistent queue for decisions an agent would otherwise escalate to a human. State lives at `.harnery/decisions/` (one manifest per decision + a bodies dir + an archive), mirroring councils. Lifecycle `filed → triaged → deliberating → resolved → enacted → reviewed → archived` (plus `superseded`/`wontfix`), validated through a single transition chokepoint. The engine is generic: it stores a `tier` (0/1/2) + `stakes` but never interprets them — the triage rubric is host policy applied by the filing agent. `resolve` requires ≥1 evidence citation (evidence-free resolutions are bounced). `file`/`resolve`/`review`/`archive` emit canonical `decision.*` events. Surface: `file|list|show|search|claim|resolve|review|triage|archive|reopen|supersede|wontfix` — `archive --graduated-to <ref>` is the graduation exit that closes a reviewed decision into the searchable archive, and `reopen` (alias `unarchive`) is its inverse for a mis-archive. Automated deliberation dispatch (a scheduled sweeper, council escalation) is intentionally left to a follow-up.
- f4fc810: docs lint: add opt-in `docs-root-file` rule. Hosts can pass `context.docsRootAllowlist` (a list of filenames permitted loose at the parent repo's `docs/` root); any other `.md`/`.json` there is flagged so topic docs stay in `docs/<topic>/` subdirs. No-op when the allowlist is unset, so standalone `harn` and non-opting consumers are unaffected. Parent-repo only — submodule `docs/` roots keep their own entry tiers.

### Patch Changes

- f4fc810: `consumeSince` no longer reads the whole event stream on its fall-through path. When the cursor missed the 2MB tail window it did a `readFileSync` of the entire `.harnery/events.ndjson`, which throws V8's max-string-length error ("Cannot create a string longer than 0x1fffffe8 characters") once the append-only ledger passes ~512MB, silently aborting Stop-hook heartbeat projection (caught + logged as `stop-projection`). The fall-through now reads at most a capped tail (`fallbackCapBytes`, default 64 MiB, env `HARNERY_AGENT_COORD_FALLBACK_CAP_BYTES`), dropping the partial leading line, so projection stays correct on an arbitrarily large ledger. Events older than the cap are stale for coord-state purposes and the projector is idempotent, so the bounded replay is safe.

  The same overflow was fixed in the `agents trace` and `agents health` CLI scans, which also read the whole stream (`trace` unguarded, so it hard-crashed past 512MB). Both now use the shared `readStreamTailBounded` helper (128 MiB cap); `trace` prints a stderr note when the ledger exceeds the window so the truncation is not silent.

- f4fc810: The harness-probe helper (`harn agents probe` machinery) set and read stale host-prefixed coordination env vars that core no longer honors, so its `TEST_ANCHOR_PID` / root-override / off-switch overrides silently never applied. Aligned them to the `HARNERY_`-prefixed names core reads via `coordEnv()` — the probe now exercises the same env contract as the live hot path.
- f4fc810: Internal runtime identifiers that embedded the host abbreviation are retagged to harnery's own `harn-` prefix: cookie-jar `source`/`exportedFrom` tags (`harn-cookies`, `harn-browse`, `harn-fetch`, `harn-browse-ai`), temp-file name prefixes (`harn-agent-browser-state-`, `harn-harness-probe-`), and the tunnel-gate log label. Provenance-only tags — no behavior keys on their values.
- f4fc810: `syncClaudeSessions` now resolves the host CLI bin via `resolveBinName()` instead of a hardcoded literal, so the Claude-Code session-telemetry sync fires for any consumer regardless of its bin name (previously it silently no-op'd unless the bin matched the previously-hardcoded name). The scratchpad UI-edit audit marker is now host-agnostic ("edited via UI by the operator") rather than naming a specific operator.

## 0.5.0

### Minor Changes

- 50b86b6: completion: add dynamic (install-once) shell completion via `--dynamic`. The new shim is tree-independent — it asks the live binary for candidates on every `<Tab>` through a hidden `__complete-line` entry point, so it never goes stale when commands or flags change (no regeneration/reinstall needed). `completion bash|zsh|fish --dynamic` emit the shim; `completion install --dynamic` installs it. Static generation and the legacy `__complete <provider>` callback are unchanged, so existing installed scripts keep working. A shared `resolveCompletions()` resolver (one place, all three shells) computes subcommand / option / enum / dynamic-provider candidates plus a Cobra-style directive for file fallback.

### Patch Changes

- de002fc: docs-lint: exempt leading-underscore filenames (e.g. `_template.md`) from the kebab-case naming check. The underscore prefix is a deliberate "this is a template, not a real doc" convention, so these files no longer emit a `non-kebab-filename` warning.
- 1b130a9: Claim guard: skip out-of-repo paths (fixes spurious ordering blocks from scratchpad/temp writes)

  The PreToolUse claim guard canonicalized write-tool targets but passed
  absolute out-of-repo paths (e.g. a `/tmp` scratchpad) through verbatim, so
  they entered the claim system. Because the ordering rule compares raw path
  strings, an absolute `/tmp/…` sorts before every repo-relative path
  (`/` = 0x2F < any letter), so a scratchpad write spuriously "blocked" a
  legitimately-held repo file with an ordering_violation.

  `canonicalize` now returns `null` for any absolute path not under `coordRoot`,
  and the guard filters those out. Session-private temp files are never shared
  coordinated resources and must not be claimed. The logic moved to
  `guard-path.ts` with unit coverage. The ordering_violation message was also
  corrected: it advised "release the higher claim first", but releasing does not
  stick (the heartbeat is re-projected), so it now points to the working escapes
  (edit in sorted order, or commit the blocker so it auto-prunes).

- e41fb65: Claim guard: re-editing a file you already hold no longer trips the ordering rule

  The ordering check blocked acquiring path B while holding a higher-sorting
  uncommitted path A — even when B was already in your own `files_touched`.
  Re-editing a claim you already hold acquires no new lock edge, so it cannot
  create a circular wait; the ordering rule must not block it. This was the
  dominant source of spurious `claim.ordering_violation` friction under
  concurrency: an agent doing multiple edit passes over a set of files it had
  already claimed got blocked on the second pass the moment it also touched a
  higher-sorting file (e.g. hold `README.md`, then edit `docs/x.md`, then
  re-edit the already-held `README.md` → blocked). The ordering guard now
  exempts already-held targets; genuinely-new lower acquisitions still block
  (the deadlock-prevention invariant is unchanged).

## 0.4.0

### Minor Changes

- 59406bf: feat(deinit): ask before deleting .harnery/ and point at engine removal

  Standalone `harn deinit`, run on a terminal, now asks before deleting the
  .harnery/ coord root when --purge-state wasn't passed and a coord root exists
  (defaulting to no). After a real run it also prints how to remove the harnery
  CLI itself (`npm rm -g harnery`, or the clone), which a running command can't do
  to its own package. This mirrors the shell `scripts/teardown.sh` prompts so the
  npm and git-clone paths feel the same.

  Both are gated to standalone harn: an embedding host routes output through its
  own emit and owns its install lifecycle, so `<host> deinit` stays strictly
  flag-driven and silent about removing the package. The prompt also never fires
  off a TTY, so scripted / CI runs are unchanged. The gating (shouldPromptForState)
  and the hint text (engineRemovalHint) are pure and unit-tested.

- c6bd828: feat(doctor): detect harness-hook wiring drift after an upgrade + nudge to re-init

  When a release adds or renames a hook event, an existing project's harness
  settings file keeps the old wiring until `harn init` is re-run — and nothing
  told you. Updating the package alone never surfaced it, because wired hooks call
  the `agent-hook` binary (so code fixes land for free), but newly-added events
  aren't wired until init runs again.

  Two non-intrusive surfaces now catch this, sharing one read-only comparison
  against `HARNESS_SPECS`:

  - `harn doctor` gains a `harness hooks` check: `wired + current`, or a warning
    naming the missing (and orphaned) `agent-hook` subcommands with the exact
    remedy.
  - SessionStart emits a one-line nudge when wiring is out of date, naming the
    missing hook(s) and the harnery version.

  Both fire only for a harness the project has already opted into (≥1 Harnery hook
  wired), so a bare `.claude/settings.json` never false-warns. The fix is always
  the same idempotent, additive `harn init`; removed/renamed events show up as
  `orphaned` and are reconciled with `harn deinit` then `harn init`.

  The shared types + "is this wired?" matcher moved into a new
  `core/hooks/harness/wiring.ts` so the writer (`init`), the doctor check, and the
  session-start renderer can't drift from one another.

- 59406bf: feat(deinit): rename `harn uninstall` to `harn deinit`

  The project-unwire command is now `harn deinit`, the inverse of `harn init` (the
  same pairing `git submodule deinit` uses). Behavior is unchanged: it removes
  harnery's hook entries from the harness settings file and, with `--purge-state`,
  the `.harnery/` coord root.

  The rename resolves a scope collision introduced when the hosted `uninstall.sh`
  shipped. "uninstall" now means exactly one thing, removing the CLI from the
  machine (`curl -fsSL https://harnery.com/uninstall.sh | bash`, or
  `npm rm -g harnery`), while project wiring is `init` / `deinit`. Pre-1.0, so this
  is a clean break with no alias; `harn uninstall` no longer exists. `scripts/teardown.sh`,
  the `harn doctor` drift nudge, and the docs are updated to match.

### Patch Changes

- 0b4ed15: fix(coord): stop committed claims from blocking edits + make release-claim form-robust

  Two coord-layer rough edges surfaced in long multi-agent sessions:

  - The claim ordering rule (which enforces sorted-order acquisition to prevent
    deadlock when a fresh peer is active) computed the "highest held claim" over
    ALL of an agent's `files_touched` — including files it had already committed.
    A committed file is a finished edit, not a held lock, so over a long session
    the accumulated committed claims walled off every earlier-sorted path with
    spurious `claim.ordering_violation` blocks (no real deadlock risk, since the
    files weren't being touched). The check now prunes committed-clean claims
    lazily on the would-block path — mirroring the existing peer stale-claim
    self-heal — and only blocks when a genuinely active (uncommitted) higher claim
    remains.

  - `release-claim` did an exact-string filter, but `files_touched` can hold a mix
    of absolute-under-coordRoot and canonical monorepo-relative entries, so a
    release by the "wrong" form silently no-op'd. Both sides are now normalized
    before comparison. `isFileCommittedClean` was likewise hardened to tolerate
    either path form.

- b940b3c: fix(coord): make the commit-guard wiring check portable (drop host-specific paths)

  The SessionStart "coordination hooks are NOT wired" check baked two
  host-specific assumptions into the published package — a leak from when the
  coord layer was extracted from its origin monorepo and the bash UX was ported
  to TS verbatim:

  - It hardcoded the git-hooks location as `<root>/scripts/hooks` and compared
    `core.hooksPath` against it, so any host using a different convention (or the
    default `.git/hooks`) got a false "NOT wired" warning even when the guard was
    correctly installed.
  - The remediation told every host to run `scripts/setup-hooks.sh`, a script
    that only exists in the origin repo.

  The check now asserts the _functional_ property instead of a path convention:
  it resolves each repo's effective hooks dir via `git rev-parse --git-path hooks`
  (which already honors `core.hooksPath`, worktrees, and submodule gitdirs) and
  verifies the `pre-commit` there actually invokes `agent-coord` / `agent-hook`.
  The remedy command is host-supplied via a new optional `hooksSetupHint` field in
  `.harnery/config.jsonc` (read through `resolveHooksSetupHint`); unset → a
  generic, host-agnostic message. harnery doesn't install git hooks itself, so the
  "how to fix it here" string belongs to the host, the same way `binName` does.

## 0.3.2

### Patch Changes

- 7cd5263: fix(agents): portable process-tree walks so owner + anchor resolution work on macOS

  Every process-tree walk read `/proc/<pid>/{status,comm}`, which doesn't exist
  on macOS/BSD, so the walks died after one hop:

  - The two `readPpid` helpers (hook-side `resolve/owner.ts`, CLI-side
    `coord-client.ts`) — owner resolution fell back to session-env / singleton
    heuristics instead of the pid-map ppid walk.
  - The anchor-selection comm-walk (`findHarnessAnchorPid` in `hooks/cli.ts` and
    the `agents` diagnostic probe) — returned no anchor, so pid-map self-heal
    relied on `process.ppid` being the harness binary by coincidence.

  Added a `ps -o ppid= -p <pid>` / `ps -o ppid=,comm= -p <pid>` fallback after the
  `/proc` fast path. `ps` reports `comm` as a full executable path on macOS, so a
  new pure, unit-tested `parsePsChainLine` reduces it to the basename to match the
  harness comm tokens. The Linux/WSL path is unchanged (still reads `/proc`).

## 0.3.1

### Patch Changes

- 7031edb: fix(agents): resolve owner by harness session-id env when the ppid walk misses

  The single-active-agent fallback closed the common case, but `agents status` /
  `set-task` / `whoami` still failed with `no_pidmap_entry` from a Bash-tool
  subshell whenever 2+ agents were live in the coord root, since the singleton
  fallback stays null when it can't tell which agent is self.

  Owner resolution now adds a `session_env` fallback ahead of the singleton one:
  when env + ppid-walk both miss, it reads the harness-provided session id from
  the environment (`CLAUDE_CODE_SESSION_ID`, `CURSOR_SESSION_ID`,
  `CODEX_SESSION_ID`, or the `HARNERY_AGENT_COORD_SESSION_ID` override) and
  matches it against the `session_id` recorded on each live heartbeat (same 600s
  freshness window). The match is unambiguous even with many agents live, so the
  stop hook's end-of-turn nudge to run `<bin> agents status` now works without
  `--session-id` in the multi-agent case. `whoami` reports the new resolution
  source as `session_env`.

- 1c6e63d: fix(agents): resolve the sole live agent when the ppid walk finds nothing

  `agents status` / `set-task` (and `whoami`) previously failed with
  `no_pidmap_entry` whenever the ppid walk couldn't climb back to a pid-map
  anchor — notably from a Bash-tool subshell, where the stop hook's own
  end-of-turn nudge to run `<bin> agents status` would itself error unless the
  caller passed `--session-id`.

  Owner resolution now adds a final fallback: when env + ppid-walk both miss and
  exactly one agent is live in the coord root (within the 600s heartbeat
  freshness window), that agent is unambiguously self, so it resolves to it.
  With zero or 2+ live agents it stays null and the explicit `--session-id`
  escape hatch is still required. `whoami` reports the new resolution source as
  `active_singleton`.

## 0.3.0

### Minor Changes

- 49ad9aa: feat(web): lazy-fetch the dashboard for npm consumers

  `harn web up` / `build` / `start` now auto-fetch the dashboard the first time they run from an npm install that has no bundled `web/`. They clone the harnery repo at the matching version tag into `~/.cache/harnery/web/<ref>` and install the web app's deps (web/ only, no root install, no browser download), then run it; later runs reuse the cache.

  - `--no-fetch` skips the fetch and prints manual steps instead.
  - `HARNERY_WEB_REF` overrides the git ref (default: the installed version's `v<version>` tag).

  Resolves ADR 0003. Previously `harn web up` could only tell npm consumers to clone the repo themselves.

## 0.2.2

### Patch Changes

- db26f12: Make `harn read` work on Node and fix `harn --version`.

  `harn read` previously crashed on a plain Node install: jsdom's dependency tree
  (`html-encoding-sniffer`, `whatwg-url`) does a CommonJS `require()` of the
  ESM-only `@exodus/bytes`, throwing `ERR_REQUIRE_ESM`. No version pin fixed it
  (every `@exodus/bytes` release is ESM-only). jsdom is replaced with
  [linkedom](https://github.com/WebReflection/linkedom), a lighter CJS-friendly
  DOM that `@mozilla/readability` supports and that drops the broken chain
  entirely. The `--url` option's relative-link resolution is preserved by
  injecting a `<base>` tag (linkedom's `parseHTML` has no base-URL option). See
  ADR 0002.

  `harn --version` reported a hardcoded scaffold value (`0.1.0`) regardless of the
  installed version; it now reads the real version from the package's
  `package.json`, resolving correctly under both Bun (src) and Node (dist).

## 0.2.1

### Patch Changes

- 05bc6c8: Fix the published CLI failing to boot on Node. `outline` statically imported
  `typescript` and the readability lib statically imported `jsdom` at module top
  level; since every command is registered eagerly at startup, an end user who
  installed harnery without dev deps hit `ERR_MODULE_NOT_FOUND` (typescript) or
  `ERR_REQUIRE_ESM` (jsdom's dependency tree) on any command, including
  `harn --version`. Both heavy deps now load lazily inside the command that needs
  them: `outline` resolves `typescript` only when outlining a TS/JS file (PHP and
  Python keep working without it, and a missing `typescript` degrades to a clear
  install hint instead of a crash), and `htmlToMarkdown` resolves jsdom,
  readability, and turndown on first use. `htmlToMarkdown` is now async as a
  result. `harn read` itself still depends on jsdom and remains affected by an
  upstream jsdom ESM-resolution bug on Node; that is tracked separately.

## 0.2.0

### Minor Changes

- e1e1fe6: Add `harn uninstall`, the inverse of `harn init`. Removes only harnery's own hook entries from the harness settings file (`.claude/settings.json` / `.cursor/hooks.json` / `.codex/hooks.json`), preserving any other hooks and non-hook settings, and deletes the settings file when it's left harnery-only. Keeps the `.harnery/` coord root by default; `--purge-state` deletes it (and the `binName` stamp) too. Idempotent, harness-agnostic in what it strips, and supports `--dry-run` / `--project-root`. Exposes a pure `unwireHooks()` (inverse of `wireHooks()`) for testing.

### Patch Changes

- e1e1fe6: Upgrade `commander` from 13 to 15. No change to harnery's public API or command surface; the full test and integration suite passes unchanged. Hosts that compose `createHarneryProgram` and rely on `instanceof CommanderError` should be on commander 15 too, so the thrown error matches across the package boundary.
- e1e1fe6: Reword user-facing CLI copy to drop em-dash overuse. Command and option
  descriptions, error and warning messages, agent-facing nudges, and the web
  dashboard's labels now use commas, colons, or parentheses in place of
  em-dashes. Two structural follow-ups: the scratchpad file-header delimiter
  changed from an em-dash to a colon (`# Scratchpad: agent-<name>`), unifying the
  writer, the parser, and the regexes that recover agent names from archived
  scratchpads (existing files regenerate on the next write); and the missing-value
  display glyph now routes through a single `NO_DATA` constant per module tree (the
  rendered mark is unchanged).

All notable changes to Harnery are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`CHANGELOG.md` is regenerated by [@changesets/cli](https://github.com/changesets/changesets) on release. Manual edits are limited to this preamble.

## [Unreleased]

### Added

- Initial package scaffold: Commander-based CLI entry, MIT license, Biome lint+format, Bun test runner, Astro Starlight docs site skeleton, GitHub Actions CI + release workflow stubs.
- `createHarneryProgram()` composition entry point for downstream CLIs that want to add their own commands on top of Harnery's tree.
