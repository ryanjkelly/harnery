# Changelog

## 0.31.5

### Patch Changes

- a051191: fix(stop-hook): end the Cursor end-of-turn remediation loop

  A Stop block on Cursor re-prompts by auto-submitting the message as a new user
  turn. Because repairing the ritual runs a command, that new turn needed both
  ritual signals again while the signal from the previous turn fell outside the
  window, so satisfying one rule failed the other and the two alternated until
  Cursor's followup cap.

  The Stop verdict now recognizes a turn Harnery itself opened, via a machine
  marker at the head of the followup message, and anchors the window at the last
  prompt a human wrote. Ritual signals accumulate across a remediation chain, so
  each repair makes progress and the chain terminates. The Cursor followup also
  names both commands now, which reduces the common case to one followup.

  Claude Code (exit-2, same turn) and Codex (observe-only) are unchanged. See ADR 0053.

## 0.31.4

### Patch Changes

- 7344fd9: Truncate an over-long workflow evidence label instead of failing the run.

  `evidence()` is called at the END of a stage, so throwing on an over-long label discards everything the run produced. A completed three-agent review was lost this way because its label ran 31 characters past the 200-char bound.

  The label is a display string; the substance lives in `summary` and `ref`. It is now shortened with a visible `…[truncated]` marker, matching the posture the transcript writer already takes when it shrinks an oversized record. A missing or blank label still throws, since that is a caller bug rather than an overflow.

- 7cf0e2f: Normalize punctuation in the shipped `harn-decide` and `harn-council` skill templates (and the owned-skill header marker). Instruction prose only; decision and council engine behavior is unchanged.
- 7344fd9: Register workflow children from the engine instead of relying on the child's own hooks.

  A spawned child previously became visible in `agents list` and on the workflow run page only if its adapter fired Harnery's hooks. Headless `codex exec` fires none, so codex children were invisible for the entire duration of a stage while actively working, and the run page rendered "no live session" beside a live agent.

  The engine now writes the child heartbeat itself at spawn and removes it in the `finally`, so visibility is a property of the engine rather than of whichever vendor CLI a stage happens to use. Registration is idempotent and preserves `started_at` plus any claims a hook already recorded, so hook-firing adapters keep enriching the same heartbeat. Both calls are best-effort and can never fail a spawn.

## 0.31.3

### Patch Changes

- 3fb97a0: Stop killed and swept heartbeats from coming back on the next event drain. `claim.release` and `health.heartbeat_swept` no longer seed a heartbeat when no live file exists, sweep telemetry sets `ended_at` without refreshing liveness, and `kill-heartbeat` emits a `health.heartbeat_swept` (`reason: killed`) terminal marker before its claim releases.

## 0.31.2

### Patch Changes

- 3a09039: Keep hooks written by pre-rename releases working after a package upgrade by accepting `--harness` and `HARNERY_AGENT_COORD_HARNESS` as aliases for their `adapter` replacements. `harn init` still migrates consumer settings to the current names.

## 0.31.1

### Patch Changes

- a866bc7: Fix `grep -c` and tunnel port detection on hosts without GNU tooling

  `grep -c` returned no rows on any host whose only search engine is BSD grep
  (notably macOS without ripgrep). BSD grep honours `--null` for content and `-l`
  records but ignores it under `-c`, emitting `<path>:<count>` where GNU grep emits
  `<path>NUL<count>`, so every count row was discarded as unframed output. The
  count decoder now also reads the unframed shape, splitting on the last colon so a
  path containing colons still parses.

  `tunnel`'s listening-port probe shelled out to `ss` (iproute2, Linux-only) and
  silently returned an empty set elsewhere, reporting every port as free. That let
  `allocateGatePort` hand out an occupied port and made the reload port-release
  check inert. It now falls back to `lsof` when `ss` is unavailable.

- 2c23ca9: Resolve one coordination root for the hooks and the CLI

  With a shell inside a submodule that carries its own `.harnery/`, the Stop hook
  and the CLI resolved different coordination roots, and the end-of-turn rules
  became impossible to satisfy. The hook walked up from `CLAUDE_PROJECT_DIR`/cwd
  and read the submodule's `events.ndjson`; the CLI asked git for the superproject
  first, so `agents status` emitted `state.status_checked` into a stream the hook
  never opened. Rule 1/3 filters events by `instance_id` within one stream, so a
  correctly-scoped event in the wrong file is invisible: every turn blocked, and no
  sequence of CLI commands could clear it.

  Resolution now follows the session's own heartbeat. `resolveCoordRoot()` is the
  single implementation — the hooks' `findCoordRoot()`, the CLI's `monorepoRoot()`,
  and `resolveEmitRoot()` all delegate to it — and among the candidate roots
  (every enclosing `.harnery/`, nearest first, plus the git-derived roots) it picks
  the one whose `active/` already knows this session, falling back to the nearest.
  Picking a root by shape was wrong in one direction each: preferring the
  superproject stranded a session whose adapter opened the submodule itself, and
  walking up from cwd alone stranded the mirror-image case of a superproject
  session whose shell had cd'd into a submodule. The session's heartbeat settles
  both, and the adapter-exported session id needed to recognize it reaches a plain
  tool-call subprocess even though `CLAUDE_PROJECT_DIR` does not. The single-live-
  agent fallback is deliberately not a discriminator: a lone stranger in the wrong
  root is how `whoami` came to report another agent's name, task, and file list as
  its own.

  What forced the old behavior was a layout assumption: roughly twenty call sites
  built their helper path as `<coordRoot>/harnery/bin/agent-coord`, which exists
  only when the root is a superproject carrying harnery as a submodule. Bending
  root resolution toward the superproject kept those spawns working. They now
  resolve through `coordBinPath()`, which finds the binaries from harnery's own
  package location and so works from `src/` under Bun, from `dist/` on Node, and
  from `node_modules/harnery`.

  Two failures that followed from the same assumption:

  - `agents set-task` (and `release-claim`) crashed with "null is not an object
    (evaluating 'result.stderr.trim')" instead of reporting a missing helper.
    `spawnSync` reports `status: null` AND `stderr: null` when the binary cannot be
    executed, so the `status !== 0` branch dereferenced null. Failures are now
    described by `spawnFailureMessage()`, and a helper that cannot be found is a
    named error rather than a crash.
  - `agents heal --kind heartbeat --owner <truncated>` minted
    `.harnery/active/<prefix>.json`, a heartbeat no reader resolves, while
    reporting success. Heal now refuses when the owner is a strict prefix of
    `--session-id` or of a live heartbeat's `instance_id`, and names the id to
    retry with. The diagnostics that produced those truncated ids
    (`agents context`, `whoami`, `status`, `council contribute`) quote the owner in
    full, since an abbreviated id in a message whose purpose is to hand back an id
    reads as complete and gets pasted straight into `--owner`.

## 0.31.0

### Minor Changes

- d81e92b: Give a consumer's own coordination policy the same lifecycle as harnery's block.

  The instructions block harnery splices into `AGENTS.md` is generic on purpose, because it ships to every consumer. A project with real policy of its own therefore had nowhere machine-managed to put it, and hand-maintained it next to the block, where nothing kept the two in step and nothing reported when the hand-written half went stale.

  Name a file instead:

  ```jsonc
  // .harnery/config.jsonc
  { "instructions": { "hostAddendumFile": ".agents/host-instructions.md" } }
  ```

  `init` splices that file's contents into a second managed region right after its own block, `init --check` reports drift against the source, and `deinit` removes it. Deleting the config key and re-running `init` takes the region back out, so turning the addendum off needs no new command.

  Harnery never parses or renders what the file says. That is what keeps one generic mechanism useful to consumers whose policies have nothing in common, and it is why the config key won over exporting the splicer as a primitive: `init` and `deinit` are registered inside harnery, so a host wiring its own region would have had to wrap both commands and reimplement apply, refresh, check, and remove.

  A path that is absolute, escapes the project, is missing, or is empty fails the run before the first write, so a mistake leaves `AGENTS.md` exactly as it found it rather than silently dropping a section the host believes is still there.

- d81e92b: Add `browse --assert`: assert page values without a human reading the page.

  The layout and content checks answer "does the page look right"; `--assert` answers "does it SAY the right thing" — the heading text, a price, how many cards rendered, whether an error banner is absent. It lets an agent confirm the values it expects and gate on them, instead of a person reading the page back.

  One repeatable flag with a small grammar, `<op> <selector> => <expected>`:

  - `text` — first match's trimmed text equals the expected string
  - `contains` — first match's text includes the expected substring
  - `matches` — first match's text matches the expected regex
  - `count` — number of matches vs a number or a `>=` / `<=` / `>` / `<` comparator
  - `exists` / `absent` — at least one / zero matches (no `=> expected`)

  For example `--assert 'text h1 => Welcome'`, `--assert 'count .card => >=3'`, `--assert 'absent .error'`. Results land under `asserts` in the JSON envelope (each carries the observed `actual`); `--assert-fail` exits 2 on any failure. A malformed spec (bad regex, bad count expression, invalid selector) reports an `error` and fails rather than throwing.

  This is the portable half of a value-assertion capability — an embedding host can layer domain assertions (funnel cart totals, warehouse reconciliation) on top of the same primitive. New exports: `parseAssertSpec`, `buildAssertCheck`, the `AssertOp` / `AssertSpec` / `AssertResult` types, and `Browser.checkAsserts()`.

- d81e92b: Add `browse --check-critique`: a vision-model page critic with tiling.

  Heuristic checks only catch what we can enumerate. The reason a human still eyeballs a page is the long tail — the thing that looks off without tripping a named rule. `--check-critique` hands the rendered page to a vision model and asks for that judgement, structured.

  Two design choices keep it useful and portable:

  - **Tiling.** A tall page screenshotted whole and downscaled to a model's input budget loses the detail the critique depends on. The page is cut into overlapping vertical bands (`--check-critique-band` / `--check-critique-overlap`), or one tile per element when a selector is given (`--check-critique <selector>`), each captured at full resolution and judged on its own. Findings carry their tile and document scroll offset for locality, and `--check-critique-max-tiles` bounds cost.
  - **Injection.** harnery ships no model client and no API key. The host wires a `critiqueProvider` into `HarneryProgramContext` (the same pattern as `extraHeaders`); given one tile plus the rubric it returns that tile's findings. Without a provider the check reports `skipped`, never a false pass, so the portable tiling/prompt/orchestration stays here and the model call stays in the host.

  Findings land under `critique` in the JSON envelope; `--check-critique-fail` exits 2 on any high-severity finding. A provider throw becomes a high-severity error finding for that tile rather than aborting the run. `--check-critique-rubric` overrides the default rubric.

  New exports: `bandRects`, `normalizeFindings`, `runCritique`, `DEFAULT_CRITIQUE_RUBRIC`, and the `CritiqueTile` / `CritiqueFinding` / `CritiqueResult` / `CritiqueProvider` types, plus `Browser.pageMetrics()`, `Browser.screenshotClipBase64()`, and `Browser.elementTiles()`.

- d81e92b: Add `browse --check-crowd`: flag adjacent card panels that touch.

  A page full of callouts stacked flush against each other had no gate to catch it. `--check-overlap` needs a real 2D intersection, and `--check-gap` flags _uneven_ spacing, so a uniformly-flush stack of cards passes both. Nothing measured "these two distinct panels have no breathing room between them," the single most common standalone-page layout bug.

  `--check-crowd <selector>` fills that hole. It walks the whole subtree under the selector, finds card-like panels (a full border box, a modest corner radius, or a box-shadow), and flags any adjacent same-parent pair separated by less than `--check-crowd-min` CSS px (default 6; negative separation always flags). One `--check-crowd .wrap` catches nested cases like callouts inside an accordion body.

  The panel test is deliberately narrow so it does not fire on things that are flush by design. Table cells, list and definition rows, and divided segments (a background-only cell in a `gap:1px` strip) carry no card boundary of their own and are skipped. Pills, chips, and badges (corner radius at least half their shorter side) are inline controls, not layout cards, and are skipped too.

  Results land in the JSON envelope under `crowd` (per pair: the two panels, the edge `separationPx`, the `axis`, and the shared `parentLabel`), annotate the screenshot with a teal seam along the touching edge, and gate the exit code with `--check-crowd-fail`.

- d81e92b: Add four content checks to `browse`: placeholder, image, truncation, contrast.

  The layout checks cover rendered geometry, but a page can be geometrically perfect and still ship a bug a human catches at a glance: a leaked template token, a broken image, a clipped label, unreadable text. These four checks close that gap so an agent can verify its own output without a person eyeballing a screenshot. Each runs in one page evaluation, lands in the JSON envelope, annotates the screenshot, and gates the exit code with its `-fail` flag.

  - `--check-placeholder [selector]` flags unrendered tells in the visible text: `{{x}}` and JS template tokens, `[object Object]`, `Invalid Date`, `NaN`, or an element whose whole text is literally "undefined" or "null". Bare "undefined"/"null" only flag when they are an element's entire text, so the word in ordinary prose does not trip it.
  - `--check-images [selector]` audits `<img>` for a failed load (naturalWidth 0), a still-loading image, or a stretched one (rendered aspect ratio far from the intrinsic ratio, with an object-fit that does not correct it). `--check-images-tolerance` sets the aspect deviation (default 0.1).
  - `--check-truncation [selector]` flags text actively cut off by an ellipsis or a `-webkit-line-clamp` — the author asked to truncate and the content overflows. It stays quiet on plain `overflow: hidden` clips, which are usually intentional. `--check-truncation-tolerance` sets the overflow slack in px (default 2).
  - `--check-contrast [selector]` flags rendered text below the WCAG AA ratio (4.5:1 normal, 3:1 large) against its effective background, resolved by walking ancestors to the first opaque color. Text over an image or gradient is reported as `unknown`, not failed. It runs at whatever theme the page is in, so toggle the theme with `--batch` to cover light and dark.

  Each check takes an optional selector (default: the whole body), adds `--check-<name>-fail` and `--no-check-<name>-annotate`, and reports per-hit rects, labels, and snippets.

- d81e92b: Delete the command wrapper.

  `harn session "<intent>" -- <cmd>` ran one shell command, forwarded its output, and emitted `command.start` / `command.output` / `command.end`. It is gone.

  Two things made it removable. Bare commands have been captured canonically for months: the PostToolUse tap emits `tool.pre_use` / `tool.post_use` carrying the same declared intent, so wrapping was already documented as optional for its main use case. And nothing reads `command.output` programmatically — the four references in the tree are the schema union member, two display-side name mappings, and the emitter itself. No logic branches on it.

  What made it worth removing rather than leaving alone is that the slot could not be named. Blind naming panels rejected two different candidates for two different reasons: one collided with the command that runs a bounded execution, the other was unreadable to two thirds of first-time readers and drew the strongest confusable pair in the whole command set against the checkpoint command. A name that fails twice against two different neighbours is usually reporting a scope problem rather than a vocabulary problem.

  The residual loss is real but narrow: long-running commands no longer stream per-line into the live viewer. Everything a run did is still on the ledger, one event at each end instead of one per line.

  The retired no-op subcommands (`tail`, `clear`, `path`, `trim`) go with it. `trim` existed so an older SessionStart hook would not error; no shipped hook calls it now.

- d81e92b: Distinguish planner no-proposal replan exhaustion from reviewer rejection.

  A durable goal can spend its replan budget two ways that used to look identical
  once the budget ran out: a planner run that produced no proposal at all, and a
  proposal that independent review then rejected across its bounded rounds. Both
  left the goal quiescent with an undifferentiated exhaustion reason, so an
  operator could not tell a planner that never proposed anything apart from
  review-round exhaustion.

  Governor projection now attributes each consumed replan through the existing
  plan seams — a review receipt is present exactly when a proposal was produced
  and reviewed, so its presence separates the two causes with no new record field
  or planner mechanism. When any replan was a planner no-proposal outcome, the
  projection carries a `replan_consumption` breakdown, the exhaustion reason names
  the planner explicitly instead of reading as review-round exhaustion, and
  `harn governor list` / `harn governor show` surface the distinction.

  Budget accounting, cumulative counters, and append-only record authority are
  unchanged. Records written before this change stay meaningful — a goal with no
  planner no-proposal history projects and displays exactly as before, and the
  new field is simply absent.

- d81e92b: Rename the `./core/supervisor` export subpaths to `./core/governor`.

  Renaming the supervisor to the governor moved `src/core/supervisor/` to
  `src/core/governor/` and renamed every symbol in it, but three export subpaths kept
  the old name and the old path: `./core/supervisor`, `./core/supervisor/state`, and
  `./core/supervisor/plans`. All three resolved to files that no longer exist, so on a
  fresh build any import of `harnery/core/supervisor` failed outright, and the
  `Supervisor*` symbols those subpaths advertised were already gone.

  They are now `./core/governor`, `./core/governor/state`, and
  `./core/governor/plans`, pointing at the governor module and exporting `Governor*`.
  A consumer importing the old subpath updates the specifier and the symbol names
  together; nothing that worked before stops working, because the old subpath could
  not resolve.

  A `tsc` rebuild does not delete output for a source file that moved, so the stale
  `dist/core/supervisor/` left behind by the rename kept satisfying the built path on
  the machine that made it. Two guards close that gap: a unit test asserts every
  export subpath's source target exists, and the published-package smoke test builds
  from clean and imports the renamed subpath on Node.

- d81e92b: Isolated workspace checkouts now allocate under `<writable-root>/.harnery-workspaces/`
  instead of the visible `harnery-workspaces/`, and the provider writes a
  `.gitignore` containing `*` into that parent on first allocation. The rule covers
  the ignore file itself, so the directory no longer appears in `git status` and
  consumers do not have to add an ignore rule by hand.

  The parent stays a sibling of `.harnery/` rather than moving inside it, because
  `harn deinit --purge-state` deletes `.harnery/` recursively and that directory can
  hold a preserved worktree with unintegrated work.

  Existing bindings keep the path they froze at allocation time. Reconciliation and
  retries follow the recorded parent, so a workspace created under the old name
  still reattaches, integrates, and cleans up.

- d81e92b: Add manifest-backed working artifact workspaces with agent-aware retention,
  safe cleanup previews, and a public embedding API.
- d81e92b: Rename the rest of the command surface so one word means one thing.

  Four changes land together because they are one vocabulary, and there are no aliases or deprecation windows: pre-1.0 is when a hard rename is free.

  **`harn harness` becomes `harn adapter`.** Blind naming panels could not read `harness` at all — every run called it guesswork, and more than one noted the word has to be defended against its own connotation before it can be understood. The panel's own favourite replacement was `provider`, and that was the plan of record until the collision was counted: `provider` already carries five unrelated meanings in this tree, two of which reach user-visible output. `adapter` carries exactly one. Every occurrence of it in the source was already this concept, so the command name now matches the word the implementation had picked for itself.

  **`harn workflow run <script>` becomes `harn run <script>`.** One bounded execution should not need two verbs to start. The run-scoped subcommands stay where they were, under `run`.

  **`harn context` splits.** Its continuity half becomes a top-level `harn checkpoint` with `status`, `create`, and `show`. Its orientation snapshot moves to `harn agents context`, unchanged and with every flag intact — it belongs under the noun for live sessions, which is what it reports on.

  **`harn agents council` becomes `harn council`, and `harn workflow approvals` becomes `harn approval`.** Both were buried where nobody found them. Deliberation and authorization are things a reader looks for by name at the top level, not features they stumble into three levels down.

  One implementation note worth recording, because it will look like a mistake to anyone reading the source. Executing a script is a hidden default subcommand of `run` rather than an action on `run` itself. Commander binds an option to the nearest command that declares it, and `run` shares several option names with its own subcommands, so a parent-level action silently swallowed the child's copy of `--policy` and `--json`.

- d81e92b: Refuse to freeze a specialist team that would run entirely on one subscription seat.

  Harnery does not auto-spread, and it never claimed to: a specialist with no `adapter` inherits the run's default. What was missing is that omitting the pin is silent. A team where nobody pins one reads as a multi-adapter team and behaves as a single-adapter team, and under `subscriptionOnly` that difference is a cliff rather than a curve — the concentration lands on one seat's session meter, so the seat hits its limit and every specialist stops at once instead of the team degrading.

  `governor create` now refuses that shape and says which adapters are sitting idle. The check is deliberately narrow, because a false refusal is worse than the miss it prevents: it needs more than one specialist, all of them resolving to a single adapter, subscription auth in force, and another adapter that is **attested reachable**.

  That last condition is the one that matters. Counting registered adapters would recommend spreading onto a seat that cannot start, which trades a loud failure for a quiet one — every child handed to it fails closed. Only `harn adapter attest` records that an adapter completed a real turn on this machine, so only an attestation is grounds for the advice.

  It fires at `create` because the intent freezes there with no amend path; discovering it at run time means recreating the goal. `--allow-single-adapter` says one seat is what you want.

- d81e92b: Reject an unusable evidence kind before a workflow spends anything

  `evidence()` is near the end of a workflow by construction, so a kind outside the accepted
  vocabulary threw at the finish line. A measured run lost roughly fifty minutes and three
  completed agents to `kind: "design"`: the work item went to blocked, the attempt was
  charged, and nothing in the proof could recover the result.

  The engine now reads the script before either import path and refuses any literal `kind` it
  will not accept, naming the offending value and its line. Comments, quoted code, and a
  `kind` property that is not an `evidence()` argument are all ignored, and a kind computed at
  runtime is left to the existing validation rather than guessed at.

- d81e92b: Let an operator finding reach work beneath a completed mission

  `harn work reopen --finding` on an item whose goal had already succeeded moved the item to
  `ready` and then went nowhere. The goal projection short-circuited to `succeeded` /
  `next_action: none` the moment a mission had an accepted completion, so the governor
  never dispatched the reopened item and no CLI output said why.

  A reopen under a succeeded mission now reopens the mission. A superseding `plan.reopened`
  event is appended beside the accepted `plan.completed`, which stays in the log unchanged,
  and the goal returns to ordinary dispatch with the reopened work ahead of any milestone
  reassessment. Reopening twice is idempotent, and a mission that never completed refuses.

- d81e92b: Separate what is waiting on a human from what merely wants their opinion.

  The docket mixes two things that read alike and behave nothing alike. Tier 0 and 1 already proceeded on a default, so a human looking at them is sampling for calibration and can skip any of it. Tier 2 stopped: work is parked until someone rules. Both sat in one undifferentiated queue, under a page that opens by saying review here is calibration and not approval — so the entries that genuinely need a person were filed behind a banner telling the reader nothing needs them.

  `decision list --waiting` returns only tier 2, unresolved, highest stakes first with longest-open breaking ties. The web docket leads with the same set as its own section, above the review feed, and it is what the page's attention alert now fires on, since review is a batch a human can defer and a blocked decision is not.

  Waiting cards also show how long they have been open. A filing date does not read as neglect; `open 19d 17h` does.

- d81e92b: Let a workflow stop because a human must rule, and tell that apart from failing.

  A script that concluded correctly — "this needs a person" — had no way to say so. Its only exit was `throw`, which means the opposite: the work failed, and a retry might do better. So a correct refusal and a botched attempt reached the engine as the same outcome, and everything downstream treated them the same way. A goal running with `retry_blocked` re-issued the item, the next agent reached the same correct conclusion, and the loop repeated until the attempt budget was gone. Nobody was told, because the thing it was waiting on was a person nobody had asked.

  `ctx.blocked()` names that outcome:

  ```js
  ctx.blocked({
    reason: "which subsystem owns the cart is unsettled",
    decision: "who-owns-the-cart-2026-08-01-beaf",
  });
  ```

  The run fails with class `decision`, a third member of the `environment` / `upstream` family from ADR 0046. Like those, it means the attempt was uninformative about the work, so it is uncharged and the item retries with a full budget once the ruling lands. Unlike a work failure, it is terminal: the work item goes to `blocked` with `next_action: "none"`, which is what puts it out of `retry_blocked`'s reach. That automation exists to clear failures without a human, and a correct refusal is not a failure.

  A planner can block the same way, and the goal stops rather than replanning a question the planner already answered.

  The point of the class is that a human finds out. A goal holding blocked work says what it is waiting on and names the decision, instead of reporting a count of items "needing intervention" — a phrasing that reads like a queue an agent will get to. `GovernorProjection.decision_blocked_work` carries the work/decision pairs, and `WorkProjection.blocked_on_decision` marks the item, so a dashboard or digest never has to parse reason prose to find what is parked on a person.

  Passing the docket id is what turns "something needs a human" into a question someone can answer. Blocking without one still stops the item; the operator just has to go find the question themselves.

- d81e92b: Tell agents that the orchestration commands exist.

  The block harnery splices into `AGENTS.md` is the only thing every agent in a consuming project is guaranteed to read. It described identity, peers, intent, the journal journal, artifacts, the decision docket, and councils. It never mentioned `workflow`, `work`, or `governor`.

  The effect was not subtle. Ask an agent in a harnery project to put a team together and build something, and it reaches for whatever multi-agent primitive its own adapter happens to hand it, because as far as its onboarding is concerned harnery does not have one. The three commands that exist for exactly that job stayed invisible, and no amount of README or docs-site coverage reaches an agent that never reads them.

  The block now carries a short section naming all three and, more usefully, saying when each applies: `workflow run` for one bounded pass, `work` when the objective has to outlive the attempt, `governor` when a human would otherwise babysit the loop. It also points at `workflow approvals list`, because a run that parks for authorization looks identical to a stuck one until you know to check.

  Placement is deliberate. The section sits second, directly after identity and peers, rather than at the end of the list. Being last is close enough to absent for something a reader is skimming, and absence is the defect being fixed.

  The opening line changes with it: the block previously framed itself entirely as staying out of other agents' way, which is an accurate description of a coordination layer and an incomplete description of this one.

- d81e92b: The scratchpad is now the journal, and the run record is now the transcript.

  `harn scratch` becomes `harn journal`. The command's own help had been calling it a journal for as long as it has existed, because that is what it is: dated entries an agent writes about its own work, in categories like note, plan, decision, and blocker. `scratch` promised something disposable and the feature is the opposite — it is the one thing that survives context compaction, and peers read it on purpose. The state directory moves from `.harnery/scratch/` to `.harnery/journal/`, the `./core/scratch` export subpath becomes `./core/journal`, and the dashboard panel follows.

  Taking that word meant giving up another use of it. A workflow run wrote its append-only record to `journal.jsonl`, sha256-hashed into the run proof, and one word covering both a hand-written notebook and a machine-written integrity record is exactly the collision this rename set out to remove. The run record becomes `transcript.jsonl`, which is the better name on its own merits: its parent directory was already called the transcript directory, and a transcript is precisely the record of what an execution said and did.

  Two breaking shapes for anyone reading state directly. Runtime state under `.harnery/` is untracked, so an existing checkout renames `.harnery/scratch/` by hand or starts fresh. And the run proof's integrity block now reports `transcript` where it reported `journal`, with the file at `transcript.jsonl`; a stored proof from an earlier version will not match a re-derivation.

- d81e92b: Rename the supervisor to the governor.

  `harn supervisor` becomes `harn governor`. No alias, no deprecation window — the repo is pre-1.0 and a hard rename is cheaper now than a vocabulary split later.

  The old name asked readers to hold a hierarchy in their heads. A supervisor supervises somebody, so the first question it raises is who reports to whom, and the answer is nobody: the command drives a graph of durable work toward a goal and decides how much it may settle before a human is needed. That is authority over a process, not management of people. Blind naming panels read `supervisor` as a manager of agents in every run; they read `governor` as the thing that bounds how far something runs on its own, which is what it does.

  The code had already reached for the word without anyone deciding to. The subsystem talks about governance events, governed work, and what governs what. The command name now matches the vocabulary the implementation had picked for itself.

  Everything moves with it: `SupervisorRecord` and its family become `Governor*`, the `.harnery/supervisors/` and `.harnery/supervisor-service/` state directories become `.harnery/governors/` and `.harnery/governor-service/`, the dashboard route becomes `/governors`, and the docs page moves. Runtime state under `.harnery/` is untracked, so an existing checkout needs its two directories renamed by hand or simply left behind.

  Decision records 0025 and 0026 keep their titles. They are historical, and "supervision" is still an accurate English description of what a governor does to a goal.

- d81e92b: Add `harn tunnel reload` so an allowlist change no longer costs you the tunnel URL.

  Each gate reads the Cloudflare IP allowlist once, from its environment, when it starts. Editing the config therefore did nothing to a tunnel already running, and the only remedy on offer was a full `down`/`up`. That is a bad trade: a quick tunnel's hostname is minted by `cloudflared` at startup, so restarting to admit one new IP hands back a different `*.trycloudflare.com` address and breaks every link already shared. The fix for "I cannot reach this link" destroyed the link.

  `reload` restarts the gate in place and leaves the provider process running. `cloudflared` only ever forwards to the gate's local port, so the hostname survives and the edge reconnects on its own:

  ```bash
  harn tunnel allow add 1.2.3.4
  harn tunnel reload --all
  ```

  Three details are deliberate. `--all` targets live instances only, counting and skipping stale state files rather than failing on them, because a long-running machine accumulates those and the common path after `allow add` should exit clean. Reloading a single stale instance refuses instead of proceeding, since a dead provider means the URL is already gone and no gate restart can bring it back. And the refusal is checked before anything is killed, so it cannot leave an instance with a broken URL _and_ a stopped proxy, nor reap a live gate that happens to have inherited a stale instance's recorded port.

  `allow add` and `allow rm` now point at `reload` and name only the tunnels that are actually running, instead of listing every state file ever written.

### Patch Changes

- d81e92b: The pid-map now anchors on the adapter process, not on whatever shell happened
  to run the hook.

  Anchor selection recognised a adapter by the name of its binary, and one Claude
  Code build installs its CLI under a version-numbered filename, so the ancestor
  walk matched nothing. Callers then fell back to the hook's own parent shell,
  which exits within seconds of being recorded. Every row for such a session was
  dead almost immediately, the identity walk found nothing, and sessions resolved
  as unattributed. It also meant a steady drip of dead rows, one per hook shell.

  Two ways in. A adapter that exports its own pid is believed outright, which
  Claude Code does. Failing that, the ancestor walk gets a second pass over
  executable paths, matching whole path segments so an install directory
  identifies a binary whose own name does not. The existing name match still runs
  first, so this only ever adds matches.

  Observed on the environment that prompted it: three live, correctly attributed
  rows where there had previously been none, one per agent session.

- d81e92b: Teach `browse --check-crowd` to treat wrappers of panels as peers.

  A card grid or flow of cards wrapped in a borderless container sitting flush
  against the next card used to pass crowd: only leaf panels counted, so the
  wrapper was invisible and the seam went unmeasured. Crowd peers are now leaf
  panels **or** in-flow siblings that contain at least one panel. Separation uses
  the nearest face panels inside each peer (not the wrapper boxes), so a tall
  section with a card near the top and prose below does not false-fail. Issues
  carry `beforeKind` / `afterKind` (`panel` | `composite`) so the JSON says when
  a composite peer was involved.

- d81e92b: Fix flaky Chromium launches under heavy concurrency.

  When many `Browser` instances opened at once — a full test suite, a fan-out of `browse` calls — the simultaneous `child_process.spawn`s exhausted the OS's stdio-pipe resources and Chromium launch died with an unhandled `ENOENT` that a per-call try/catch couldn't catch (it surfaced "between tests", not through the launch promise). `Browser.open()` now bounds concurrent launches with a module-level semaphore (default 3, override via `HARNERY_MAX_BROWSER_LAUNCHES`), gating only the brief spawn phase so N browsers still run concurrently, and retries the whole open sequence up to three times with teardown between attempts for genuinely transient connect failures. A 3×-back-to-back full-suite stress run that previously flaked now passes clean.

- d81e92b: Fix `browse --check-critique` tiling on pages taller than the viewport.

  The tiler captured each tile with Playwright's `clip`, which is viewport-relative — so any band or element below the fold threw "Clipped area is either empty or outside the resulting image", and critique only worked on pages that fit one screen. It now captures one full-page screenshot and crops every tile from that image in pixel space (`tilesFromFullPage`, exported), which is below-fold-safe and keeps each tile at full resolution. The crop uses a manual RGBA row copy rather than pngjs `bitblt`, which isn't available under every runtime. Verified end to end on a ~9000px page (previously errored; now tiles and critiques clean) with regression tests over a synthetic tall buffer.

- d81e92b: Declare each shared type once.

  Three types were declared more than once with byte-identical bodies, which is how two modules quietly drift into disagreeing about a shape they are supposed to share. The closed adapter-id union and the event `Source` union now live only in the hooks event schema, re-exported by the two event modules that kept their own copies. The rule verdict shape moves to `core/agents/rules/verdict.ts`, imported by both the claim-conflict and stop-hook rules. No shape changed, so nothing observable moves.

  The `Heartbeat` interface is deliberately left alone. Its two declarations look like duplicates but are not: the writer's view has optional fields the reader's view requires, so unifying them is a behaviour change rather than a cleanup.

- d81e92b: Make end-of-turn coordination checks observe-only on Codex. Harnery still records
  the turn and projects agent state, but it no longer uses a Stop continuation that
  can replace the completed user-facing answer with a status retry.
- d81e92b: Trim artifact slug edges with fixed-length patterns.

  `normalizeSlug` trimmed leading and trailing dashes with `/^-+|-+$/g`. Collapsing
  every non-alphanumeric run to a single `-` already runs first, so no input reaching
  that pattern can hold two adjacent dashes and the quantifier never had more than one
  character to match. The pattern was still polynomial when read on its own, which is
  how static analysis reports it and how it would behave if the collapse above it ever
  moved or changed. The edges are now trimmed with `/^-/` and `/-$/`, which cannot
  backtrack. Output is unchanged on every input.

- d81e92b: Pid-map rows now record which _run_ of a pid they were written for.

  A pid is a number the operating system hands back out. Measured on one
  development machine: `pid_max` of 99999 against roughly 100 new processes a
  second, so the whole space turns over about every quarter hour. Past that point
  a row can name a pid an unrelated process now holds, and everything that trusts
  the row inherits the mistake. `agents whoami` reports another agent's name and
  file list. A departed agent still reads as live, so a commit guard treats its
  claims as a live peer's and `identity assume` refuses to reclaim its name.

  Sweeping dead rows does not reach this. The sweep removes rows whose pid has
  exited; a recycled pid is alive, so the rows it removes are the harmless ones
  and the row it keeps is the wrong one.

  Each row now carries a start token alongside the instance and platform, and
  every place that believes a row checks it: the sweep, the liveness query, and
  both identity walks. The token is opaque and compared only for equality. Linux
  reads start ticks from `/proc` with no subprocess, BSD pays one `ps -o lstart=`,
  and a platform that will not say writes no token at all. Rows without one, which
  is every row on disk today, keep behaving exactly as they did.

  Also fixes platform parsing, which took everything after the first tab and so
  would have swallowed the new field.

- d81e92b: Harden the pid start token against three ways it could name the wrong process.

  The token that tells a pid-map row apart from a recycled pid had gaps on the paths that are hardest to notice, because each one produces a _false_ mismatch: a live row gets pruned, and the identity walk lands on the same wrong answer the token was added to prevent.

  The `ps` probe read a date formatted through the caller's timezone and locale, so a hook running under `LC_ALL=C` and a shell running under the user's settings described one live process two different ways. Both are now pinned, and a regression test checks it through subprocesses launched under different timezones, since assigning `process.env.TZ` never reaches a child and a test written that way passes either way.

  The Linux token counted ticks from boot, and pid-map rows live in the working tree and outlive reboots, so a stale row could match a fresh process that landed on the same pid at the same moment of a later boot. The count is now scoped to the boot it came from. Rows written before this recorded ticks alone and are still compared on what they recorded, so upgrading does not prune a working machine's live rows.

  The two probes could also mix: a procfs read that failed fell through to `ps` and answered in the other dialect. The probe is now chosen once per machine and never fallen back from.

  The `ps` path is the same code wherever `ps` exists, so `HARNERY_PID_PROBE` forces it and the tests exercise the whole pid-map lifecycle through it rather than leaving that branch to be discovered on somebody's laptop. A parity test holds `coord-client`'s inlined copy of the probe against the canonical one, so the two cannot drift apart in silence.

  One upgrade note for machines without procfs: rows already holding a `ps` token written in the local timezone read as mismatches once, since a shifted date cannot be told from a different one without parsing it. Those rows are pruned and rewritten on the next hook, costing one invocation that resolves identity through the session environment instead of the pid walk. Every failure path in the probe still ends in "unverifiable", which trusts a live pid exactly as it did before tokens existed, so no platform ends up worse off than it started.

- d81e92b: Point the injected instructions block at a council command that exists

  When a consumer excludes the `harn-council` skill, the generated AGENTS.md block
  fell back to telling agents to run `<bin> council --help`. There is no top-level
  `council` command; the surface is `<bin> agents council`, so that pointer sent
  every agent on such a project to a command that does not resolve. The fallback
  now names `<bin> agents council --help`. Consumers that ship the skill were
  unaffected, since they get the skill pointer instead of the fallback.

- d81e92b: Point the injected instructions block at the renamed commands.

  The block spliced into a consuming project's `AGENTS.md` still told agents to run `workflow run <script>` and `workflow approvals list`. Both moved in the same release that added those lines. They are now `run <script>` and `approval list`.

- d81e92b: Remind human-facing Codex sessions on every prompt to append the live agent
  status after the substantive answer. Stop enforcement remains observe-only, so a
  missed footer cannot trigger a status-only replacement response.
- d81e92b: Stop the pre-commit guard blocking a session against its own commit, which had
  made `HARNERY_AGENT_COORD_BYPASS=1` routine even though that flag also disables
  the genuine conflict check.

  The read-only git probes behind the self-attribution gates now run with git's
  repository-discovery environment scrubbed. A git hook exports `GIT_DIR` and
  `GIT_WORK_TREE`, children inherit them, and they outrank `cwd`, so every probe
  questioned the repository being committed rather than the one owning the path it
  asked about. Those probes also now run from the path's own directory, so a claim
  recorded monorepo-relative resolves against the repository that actually tracks
  it at any nesting depth, and a git-ignored path no longer counts against the
  holder, since an ignored path cannot enter anyone's commit.

  Also bounds the pid-map. Rows are written per hook shell, those shells exit
  immediately, and nothing pruned them, so the map only grew. Stale rows are not
  only clutter: pids get recycled, and an identity walk that lands on a reused pid
  resolves to a long-gone agent. Writes now sweep dead rows once the directory
  passes 200, liveness treats `EPERM` as alive instead of counting another user's
  process as gone, and the hook path calls the shared writer rather than its own
  copy, so the sweep reaches the only hot write path in the system.

- d81e92b: Tell every interactive adapter how to surface Harnery's suggested session name
  on its first prompt.

  The shared prompt hook now detects that no `set-task` call has occurred, asks
  the agent to declare its focus first, and tells it to reproduce the returned
  `suggested_session_name` in a fenced code block. The reminder uses the host
  CLI's configured binary name, fires once per session, and skips subagents and
  workflow children.

- d81e92b: Identity resolution now asks the adapter before it guesses from the process tree.

  Every supported adapter exports its session id into the environment of the
  subprocess it spawns for a tool call, and every heartbeat records the session id
  it was minted under. Matching the two names an agent outright. That check used to
  run only for Cursor, and only after the ppid walk had already failed, so on every
  other adapter a pid-map row outranked it.

  Rows name pids, and pids get recycled. Measured on one development machine:
  `pid_max` of 99999 against roughly 100 new processes a second, so the whole pid
  space turns over about every quarter hour. A row older than that can name a pid
  some unrelated process now holds, and the walk resolves to whoever wrote it. That
  is how `agents whoami` came to report another agent's name and file list.
  Sweeping dead rows does not address this: it removes rows whose pid has exited,
  and a recycled pid is alive.

  Only the order changed. Session-env resolution still requires a live heartbeat
  carrying that session id, so when it does not match, the walk runs exactly as
  before.

- d81e92b: Stamp `HARNERY_WORKFLOW_AGENT_ID` into workflow children, so a dashboard can tell
  which agent row a live child session belongs to rather than only which run.

  A child cannot be identified by its session id while it is working: the adapter
  mints that id and reports it back only in the result envelope, which is to say
  only once the work is over. Passing in the id the orchestrator already owns is
  what makes live per-agent attribution possible. The engine supplies it at
  dispatch, every spawn adapter forwards it, `session.start` carries it as
  `workflow_agent_id`, and the heartbeat projector puts it on the child's heartbeat
  beside `workflow_run_id`.

- d81e92b: `harn web up` and `harn web start` now pin a V8 old-space ceiling (2048 MB by default) instead of letting Next size it to roughly half of system RAM.

  On a large machine Next's own ceiling is one the dashboard never approaches, so V8 never feels enough pressure to run a major GC and a long-lived server settles at a multi-gigabyte working set of mostly collectable garbage. Tune with `--max-old-space <mb>` or `HARNERY_WEB_MAX_OLD_SPACE`; pass `0` to restore Next's sizing. A ceiling already present in `NODE_OPTIONS` is left untouched.

## 0.30.0

### Minor Changes

- 8de2116: Charge a durable-work attempt only when it produced information about the work
  (ADR 0046). A failure that never touched the work no longer spends the fixed
  `max_attempts` budget, and the two ways a run can be uninformative get opposite
  handling.

  An **environment** failure — the vendor binary was absent, so the run never
  started — stops the item immediately and names the missing precondition, instead
  of retrying an unchanged `PATH` until the budget runs out. It is detected
  structurally: `exec()` now surfaces the spawn errno (`ENOENT`), carried through
  `HarnessRawResult` to each adapter, so a genuine missing binary is distinguished
  from a shell that merely exits 127.

  An **upstream** failure — the vendor was reached and refused (5xx, 429, circuit
  open) — goes uncharged but stays retryable, bounded by a new, separate
  `max_uncharged_attempts` (default 3) so an outage that never ends cannot retry
  forever; at the bound the item reports it is blocked waiting on an outside
  service, distinct from blocked on the work.

  Anything not positively identified as environment or upstream is charged exactly
  as before, so a proof or attempt written before this change behaves unchanged.
  The projection gains `charged_attempts` alongside `attempts_used`: `max_attempts`
  now budgets charged attempts, while `attempts_used` still counts every attempt
  for history ordering and the next attempt number.

  The same rule governs the supervisor's replan budget, where most of the measured
  bleed occurred: a planner run that never touched the plan is classified from its
  proof and stamped on the `plan.failed` event, so an environment failure stops the
  goal and names the precondition instead of replanning an unchanged environment,
  and consecutive upstream failures go uncharged against `max_replans`, bounded by a
  small consecutive limit. The in-agent spawn-retry loop also stops immediately on
  an environment failure rather than re-spawning an absent binary.

## 0.29.0

### Minor Changes

- a76aedf: Let a durable-work attempt run in an isolated workspace. `harn work run` and
  `harn work retry` accept `--workspace-root`, matching `harn workflow run`, and
  build the local Git worktree provider from it.

  Before this, `--isolation worktree` was accepted and validated on `work run` but
  could never be honoured: the command never constructed a workspace provider, so
  every attempt fell back to shared. The fallback was recorded in the proof as
  requested versus effective isolation, but the human output said nothing, so an
  operator who asked for isolation on the durable-work surface got a shared run and
  no indication of it. That surface is the one a project is handed to, which is
  exactly where isolation matters.

  Both attempt entry points take the flag, so a retry after a blocked isolated run
  does not quietly drop back to shared. On resume the root is checked against the
  frozen binding rather than replacing it. `--workspace-root` without
  `--isolation worktree` is now refused instead of ignored, and a run that requested
  isolation but allocated none reports that on the success path rather than leaving
  it in the proof for nobody to read.

- 9d69ee4: Allocate isolated workspaces from linked worktrees and submodule checkouts, not
  just plain repositories. `inspectSourceRepository` refused any checkout whose
  `.git` was not a real directory, which rejected the four shapes whose `.git` is a
  `gitdir:` pointer file — a linked worktree, a submodule checkout, a worktree of a
  submodule, and the submodule this package is embedded as — even though `git
worktree add` supports all of them. The directory check was a shortcut for a
  property: that the provider can name every path git will write to, each inside the
  declared writable root, each covered by `allowed_paths`, and each provably the
  authority git itself uses. That property is now proven directly — resolve `.git`
  (directory or pointer file, symlink still refused), require it to equal `rev-parse
--git-dir`, and assert the git dir sits inside the common dir — so the containment
  and `allowed_paths` checks that were trivial in the plain layout become
  load-bearing in the others.

  Three coupled fixes follow: the repository lease keys on the Git common directory
  alone, so several checkouts sharing one admin area (a superproject and its
  worktrees; a submodule and a worktree of it) serialize their `worktree
add`/`prune`/shared-`config` writes instead of racing under different lease keys;
  `probe` now refuses a layout whose authority no declared writable root covers,
  naming the common directory rather than reporting supported and failing later at
  `allocate`; and integration apply re-authorizes the common directory against
  `allowed_paths`, since a submodule fast-forward moves a ref outside the checkout
  tree. See ADR 0045.

## 0.28.0

### Minor Changes

- f0ca84d: Add `browse --capture-evaluate <js>` for trio mode: evaluate JavaScript inside the
  exact viewport used for the screenshot, immediately before capture, and write the
  result alongside it as `captureEval`. Full-page capture now converges its
  evaluation viewport under explicit pass, dimension, and pixel limits, records the
  final document and PNG dimensions, reports nonconvergence rather than emitting
  mismatched evidence, and restores the original viewport on every exit path.
- 6331dcf: Stop an oversized workflow journal record from breaking work listing or the run
  that writes it.

  The writer and the reader disagreed on size, and nothing kept them in agreement:
  records were written up to 32 KiB while the reader refused anything over 16 KiB,
  so a single large agent result made `work list` fail for every work item at once.
  The engine also bypassed the bounded writer entirely with a raw append.

  Both sides now hold. `appendWorkflowJournalEvent` is the only writer, and instead
  of refusing an oversized record it drops the largest fields for a digest and byte
  count, names them under `omitted_fields`, and always writes. Refusing was not an
  option: `run.start` carries workflow metadata and frozen work context that
  Harnery's own validators permit to exceed the limit, so a valid run could fail on
  its opening line. On the read side, a journal that still cannot be parsed marks
  that attempt `journal_unreadable` and blocks it with the reason, leaving every
  other work item listable.

- b5308b4: Add operator findings at the durable-work review gate. `work reopen` now accepts
  `--finding <text>` (repeatable); each finding is recorded on the reopen event and
  carried into the next attempt's frozen context as `attempt.findings`, so the team
  can act on a correction the reviewer missed. Acceptance fails closed while a
  finding is open: `work accept` requires `--dispose <id>=fixed` or
  `--dispose <id>=deferred:<reason>` for each one, and the dispositions are recorded
  on the acceptance event. Existing attempt contexts without findings stay canonical.

### Patch Changes

- 71b4cca: Tell an operator _why_ an attempt's journal could not be read. `work show` now
  renders the recorded reason next to a `journal_unreadable` attempt instead of the
  bare status. The reason is whitespace-normalised and truncated for the human
  render so a long or multi-line error cannot break the one-line-per-attempt shape
  of the `attempts:` block; `--json` still carries the full value.
- bf5f313: Classify a workflow child killed for exceeding its timeout as failed, whatever it
  exits with. `exec()` now reports `timedOut` when it fired the kill, and every
  harness adapter checks that before any exit-code branch. Previously a vendor CLI
  that handled the signal cleanly exited 0 and wrote no result, which was
  indistinguishable from a successful empty reply: the run recorded `agent.end` with
  no error, passed an empty string downstream, and surfaced the failure as a schema
  error on whichever agent consumed it next.

## 0.27.0

### Minor Changes

- 771e87b: Add `harn workflow reclaim <run-id>`, which resolves a workspace stuck at `preserved_dirty`.

  Preserving a dirty worktree was already correct, and it was also permanent: cleanup re-attempted, found the tree still dirty, preserved again, and incremented a counter. The only exit was to leave Harnery and remove the directory by hand.

  Reclaim salvages the uncommitted work to a durable `harnery/salvage/<run-id>` branch, then hands off to the ordinary cleanup path to release the now-clean workspace. `--discard` throws the work away instead, and is never the default. Neither mode deletes anything itself, so cleanup remains the only path that removes a worktree.

  Salvage commits and then rewinds the checked-out branch, because cleanup deletes the workspace branch and pins its OID in a frozen intent. A workspace whose directory is already gone reports `already_gone` rather than incrementing attempts forever.

  `harn workflow workspace <run-id>` now lists the dirty paths alongside the count it already printed.

- 620fc0f: Add `filesystemPolicyProjection` as its own harness capability dimension, with a live probe that proves enforcement rather than flag acceptance.

  Sandbox projection was previously conflated with `policyMapping`, which is about ALLOW/DENY/ASK translation and is a different fact. Folding both into one claim would have made `supported` ambiguous, so projection now has its own dimension and `policyMapping` keeps its meaning.

  `harn harness attest --projection` attests the new dimension. A declared-but-unenforced sandbox is indistinguishable from an enforced one at the CLI boundary, so the probe gives a child a file to write and checks the filesystem. It runs a control turn under a permissive mode first: without it, a child that ignored the instruction would read as a working sandbox. An inconclusive control records nothing. The flag is opt-in because it costs two extra turns per capable harness.

  Offline, `harn harness bench` checks only whether the adapter renders the projection, and labels that with an `adapter` basis rather than an `attested` one.

- a3809e2: Add `EngineOpts.gitWrite`, a named grant for write access to a repository's Git administrative directory.

  A workflow run that needs its children to commit can now set `gitWrite: "shared-repository"`. The engine resolves the concrete paths from the workspace binding the provider verified, appends them to the projected filesystem policy, and records the grant in run proof. The default is `"none"`.

  The caller asks by name and never supplies the path. Caller-supplied `writableRoots` must still lie inside the workspace, so this grant is the only sanctioned way for a run to write outside it.

  Two measurements shaped the design and are recorded in ADR 0040: in a linked worktree both halves of the administrative directory live outside the workspace root, and a commit needs the shared half, so no scoped version of the grant exists.

- 7064efe: Project the host's filesystem policy into a harness's own vendor sandbox.

  `SpawnRequest` gains an optional `filesystemPolicy` carrying a mode
  (`read-only` or `workspace-write`) and an explicit set of writable roots. Each
  harness profile declares what it can represent, and an adapter that cannot
  represent a requested projection refuses before launch rather than silently
  falling back to the vendor default.

  This closes a gap where a child in a provider-owned Git worktree could edit
  files but not commit. The vendor excludes a repository's administrative
  directory from its writable set by policy rather than by path, so no repository
  topology avoids it; naming the directory as a writable root does. Verified end
  to end against the real CLI.

  The engine validates every requested writable root against the root the
  workspace provider validated, before the first child launches, and records the
  applied projection in run proof as `sandbox_projection`.

  Of the three built-in adapters, only `codex` can carry a projection today.
  `claude-code` and `cursor` declare it unrepresentable and refuse. Requests
  without a `filesystemPolicy` are unchanged, so shared-checkout runs behave
  exactly as before.

### Patch Changes

- 51f1607: Add copyable diagnostic pages for tunnel access and upstream failures.

## 0.26.0

### Minor Changes

- 830ae2a: Record the billing mode an attestation ran under, and stop truncating vendor
  failures from the wrong end.

  `harn harness attest` gains `--subscription-only`, matching
  `workflow run --subscription-only` and the repo default in `config.jsonc`. The
  mode is stored on the record and invalidates it when it differs, because a child
  that may fall back to an API key can succeed where one restricted to its stored
  login fails. Attestation records move to schema version 2; existing records are
  rejected and should be re-recorded.

  All three spawn adapters previously reported the FIRST 500 characters of a
  failed child's output. A vendor CLI prints its banner and resolved config first
  and the reason it failed last, so that reliably preserved the banner and
  discarded the cause: a child that died with "your workspace is out of credits"
  reported a cosmetic startup warning instead. Failure text is now tail-preserving
  and includes both streams, since which one carries the reason varies by vendor.

### Patch Changes

- 03929da: Correct the recorded vendor contracts for the `claude-code` and `cursor`
  profiles from live attestations.

  `claude-code` recorded the placeholder string `"current CLI contract"`, which is
  not a version, so its `contract` bench row could only ever report `unknown`. It
  now records the version its declaration was actually validated against.
  `cursor` recorded a version several releases behind the one it was validated on.

  `codex` recorded a prerelease it was not running either, and is corrected to
  `codex-cli 0.144.5`.

  All three are now written from an attestation rather than by hand, and all three
  `contract` rows reconcile.

## 0.25.0

### Minor Changes

- 23d2f77: Bench results now state the basis they were established on, and the bench
  checks the installed vendor contract.

  Every `BenchResult` carries a `basis` of `adapter` (checked against Harnery's
  own planner, normalizer, or fixture), `attested` (checked against the installed
  vendor CLI), or `declared` (not checked). The report gains a `basisSummary`
  rollup. Previously a clean bench read as "no disagreement found" when the
  accurate reading was usually "no vendor behavior was observed".

  A new `contract` dimension compares the vendor CLI version a profile's
  declaration was validated against with the version the installed binary
  reports, and raises `drift` when they differ. The `verified` field on
  `HarnessProfile` was inert before this change.

  `harn harness bench` keeps its surface, its exit-on-drift contract, and its
  behavior on hosts with no vendor CLI installed. The text report gains a BASIS
  column; the JSON report is extended, not reshaped.

- fa6f7ca: Add live harness attestation: record what an installed vendor CLI actually does.

  `harn harness attest --yes` runs one bounded turn per harness through the
  adapter's production spawner and records the result under
  `.harnery/harnesses/attestations/`. `harn harness attestations` lists the
  records without making a model call. `--yes` is required because the probe
  spends real vendor tokens.

  `harn harness bench` now reads those records. A current attestation supplies the
  observed value for the dimensions it covers and marks them `attested`, so a live
  observation that disagrees with the declaration becomes drift. Records are
  invalidated automatically by a vendor version change, a declaration edit, or a
  failed integrity digest, and stale records fall back to `adapter` basis.

  Workflow proof gains an optional `attestation` citation on each
  `HarnessEvidenceCoverage` entry. A missing attestation is not a new proof
  unknown, so an unattested host keeps its existing gate behavior.

  New exports from `harnery/core/harnesses`: `runHarnessAttestation`,
  `harnessProofInputs`, `probeBinaryVersion`, and the attestation store surface.

## 0.24.0

### Minor Changes

- 1cb5506: Add phased CLI commands for proof-gated workspace integration and conservative
  cleanup, with explicit policy, review, and mutation confirmation. When
  integration prepare parks on a host-policy ASK, expose the exact run, plan, and
  approval IDs as a handled park instead of a generic failure. After approval,
  point the operator back to the same integration prepare operation using the
  host's configured binary name.

### Patch Changes

- f8151a7: Allow non-interactive Cursor workflow children to run their checks and create
  commits after the host authorizes dispatch.
- 1b49db9: Clean up an unmodified recovery claim when another workspace lease contender replaces the observed owner first.

## 0.23.0

### Minor Changes

- 3f3db3d: Add the optional durable workspace-provider lifecycle and local Git worktree
  provider through `core/workflow`, including explicit CLI allocation, validated
  status readers, dashboard visibility, proof-gated integration, recovery, and
  cleanup.

### Patch Changes

- 3f3db3d: Preserve an explicitly configured Codex home when scrubbing parent-session variables from workflow children.

## 0.22.1

### Patch Changes

- d1d9add: Accept one unambiguous schema-gated JSON object or array after a harness-added leading sentence while continuing to reject trailing prose, multiple candidates, malformed values, and schema mismatches.

## 0.22.0

### Minor Changes

- 23dae82: Expose frozen attempt identity to work-linked workflows and give each explicit or supervisor-authorized retry a bounded synopsis of the preceding terminal evidence. Persist the same context in the private run manifest, journal, and proof while preserving all existing work and goal-wide attempt ceilings.

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
