# Changelog

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
