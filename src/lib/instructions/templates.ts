/**
 * The agent-facing content harnery ships into a consumer: one orientation block
 * for `AGENTS.md` and the generic skills. Everything here is engine mechanics
 * only — no triage rubric, no escalation targets, no host doc-layout policy
 * (those stay host-authored, per ADR 0007's portability split). Every command
 * string renders through `binName`; a template that only reads for `harn` is a
 * bug the portability guard exists to catch.
 *
 * Content, not paths: templates are TS string builders (not shipped `.md`
 * files), so they compile into `dist/` and resolve identically under Bun and
 * Node — no `files`-field copy or package-path guesswork.
 */

import { JOURNAL_CATEGORIES } from "../../core/journal/index.ts";
import { buildOwnedSkill } from "./splice.ts";

/** Managed-region name for the AGENTS.md orientation block. */
export const INSTRUCTIONS_REGION = "instructions";
/** Managed-region name for the CLAUDE.md `@AGENTS.md` import shim. */
export const IMPORT_REGION = "import";
/**
 * Managed-region name for the consumer's own coordination policy, spliced from
 * the file named by `instructions.hostAddendumFile`. Harnery places and
 * versions the region; the content is the host's and is never rendered here.
 * See `host-addendum.ts`.
 */
export const HOST_ADDENDUM_REGION = "host-addendum";

/** Which shipped skills exist in the project the block is rendered for. */
export interface BlockSkills {
  /** the `harn-decide` skill file is present */
  decide: boolean;
  /** the `harn-end` skill file is present */
  end: boolean;
  /**
   * the opt-in `harn-computer` skill file is present (only when the project
   * turns `computer` on through `mode` or `enabled`); absent from the default block entirely
   */
  computer?: boolean;
}

/**
 * The always-on orientation spliced into `AGENTS.md`. Target ≤ 80 rendered
 * lines: it costs every agent context on every turn, so it states that each
 * surface *exists* and gives one line of *when* — the *how* lives in the skills
 * and each command's `--help`. Skill names are fixed (`harn-decide`,
 * `harn-end`) even for a renamed bin; only command strings
 * track `binName`.
 *
 * The block only points at a skill that actually exists here: a host that
 * excludes one via `skills.exclude` gets a CLI pointer instead of a dangling
 * reference to a skill it doesn't have.
 */
export function renderInstructionsBlock(
  binName: string,
  skills: BlockSkills = { decide: true, end: true },
): string {
  const b = binName;

  const named = [skills.decide && "`harn-decide`", skills.end && "`harn-end`"].filter(
    Boolean,
  ) as string[];
  const deeper =
    named.length > 0
      ? `Procedures for the deeper flows live in the ${named.join(" and ")} skill${named.length > 1 ? "s" : ""}.`
      : `See \`${b} decision --help\` and \`${b} agents --help\` for the deeper procedures.`;
  const decidePointer = skills.decide
    ? "The `harn-decide` skill has the file / claim / resolve-with-evidence procedure."
    : `See \`${b} decision --help\` for the file / claim / resolve-with-evidence procedure.`;
  const endPointer = skills.end
    ? "When the whole session is genuinely finished, use the `harn-end` skill as the final workflow."
    : `When the whole session is genuinely finished, run \`${b} agents status --end-turn --end-session\` as the final tool action.`;
  // Opt-in surface: the default block stays byte-identical unless the project
  // enabled computer use and the skill is actually installed.
  const computerPointer = skills.computer
    ? `\n\n**Desktop control.** This project enables \`${b} computer\` for driving native desktop apps and real browsers. Work invisibly first (APIs, CLIs, files, \`${b} fetch\`, headless \`${b} browse\`) and deliver results in the chat as an answer, a link or a picture; open a page in the person's browser only when they ask ("show me" counts). Your agent app's own browser (a built-in pane, or its control of the person's Chrome) comes last, after every other route failed. Use the desktop for a desktop program with no file or API route, a site that refuses the headless browser, or work the person will continue in a window no link can hand them. The \`harn-computer\` skill has the routing, the approval step and the loop, and the desktop is one shared resource held by one agent at a time.`
    : "";
  // Render the journal categories from the canonical enum so this prose can
  // never drift from what `journal add` actually accepts (the "note, plan…" list
  // silently lagged the tool by two categories before this).
  const journalCats =
    JOURNAL_CATEGORIES.length > 1
      ? `${JOURNAL_CATEGORIES.slice(0, -1).join(", ")}, or ${JOURNAL_CATEGORIES.at(-1)}`
      : JOURNAL_CATEGORIES[0];

  return `## harnery coordination

This project runs [harnery](https://harnery.com) for multi-agent coordination.
You share this checkout with other agents; the surfaces below keep you oriented
and out of each other's way. Run \`${b} <command> --help\` for any command's full
surface. ${deeper}

**Identity + peers.** You are one of several agents in this repo.
\`${b} agents whoami\` is you; \`${b} agents status\` shows your session plus the
active peers and the files they've claimed; \`${b} agents set-task "<focus>"\`
declares your current focus so peers can see it. Check for peers before editing
widely-shared files.

**Task lifecycle.** Beside the activity peers already see, declare whether your
objective is still open: \`${b} agents lifecycle blocked --reason "<why>"\` when
it cannot proceed, \`${b} agents lifecycle done\` when it is complete, and
\`${b} agents lifecycle active\` to reopen. \`done\` requires a current task, no held file claims, and a passing Git finalization check (dirty or unpushed work refuses, and nothing is
written). Ordinary \`set-task\` calls never change lifecycle, and a transition
that re-mints the session title tells you the new name to copy. ${endPointer}

**Starting other agents.** Use your harness's own subagent tool to hand a
bounded task to a helper. For a scripted fan-out, \`${b} run <script>\` runs
plain JS stages that start headless subagents, already registered for
coordination, with deterministic code deciding the routing between stages. A
run that needs authorization parks instead of failing, so check
\`${b} approval list\` when one seems to be waiting rather than stuck.

**Durable role handoff.** When you are replacing a prior session in the same
named role, run \`${b} agents identity assume <name>\` before declaring your task.
It reclaims an abandoned namesake (no live process) and refuses only when another
live process still holds the name; never hand-edit Harnery's history, heartbeat,
or derived identity cache.

**Declare intent on shell commands.** Every command you run is captured to the coordination ledger (\`${b} events query\` searches all of it). Lead a shell command with a
\`# intent: <why>\` comment (or set the tool's description) so the recorded event
carries a reason instead of \`(no intent)\`; the [tool-intent
guide](https://harnery.com/guides/tool-intent/) owns the details.

**Messaging another agent.** \`${b} agents ping <name> "<message>"\` reaches an
agent by name, running or not, here or on another machine sharing this origin:
a live agent sees it on their next prompt (after a fetch, if remote), and a
dormant name holds it until that session next starts. Send it as your only step;
do not check who is live first or hunt elsewhere. Only an unused name is refused.

**Journal.** \`${b} journal add <category> "<text>"\` (category = ${journalCats})
leaves breadcrumbs that survive context compaction;
\`${b} journal read\` reads yours, \`${b} journal read --name <peer>\` reads a peer's.
Use it for anything future-you or a peer will need to pick up your thread.

**Working artifacts.** For screenshots, exports, audit dumps, rollback inputs,
and other untracked files that must survive a session, create a managed workspace
with \`${b} artifacts create <slug> --purpose "<why>"\`. Write files under the
returned path, then run \`${b} artifacts release <id>\` when active work is done.
After review, use \`${b} artifacts discard <id> --reason "<why no longer needed>"\` for disposable or superseded evidence: it releases ownership and shortens retention to at most 60 minutes (\`--minutes\` overrides). Keep unresolved failures, handoffs, final evidence, and files awaiting review; use a hold when needed. A passing check cannot establish whether another reader needs the files, so the reviewing agent decides. For known short-lived work, \`${b} artifacts create --minutes <n>\` sets the initial window.
Do not create a repo-root temp directory; \`${b} artifacts clean\` previews
expired cleanup and requires \`--yes\` to delete anything.

**Removing local outputs.** Use \`${b} rm --root <directory> <paths...>\` instead of shell \`rm\`, which skips resolved-path, Git ownership, and peer-claim checks. Preview
is the default; \`--yes\` deletes permanently and \`--recursive\` permits directories.
Use \`git rm\` for tracked source and the artifact commands for managed evidence.

**Local file links.** When the operator should open a local repo file, mint the
URL with \`${b} files url <repo-relative-path>\` instead of guessing it. HTML opens
as a real page with working scripts and relative assets; other files open in the
dashboard viewer. Use localhost links only when the operator shares this machine.

**Decision docket.** When you would otherwise stop to ask a human a decision you
can't resolve from the repo, file it instead. \`${b} decision file "<question>"\`
records it and lets you proceed on a stated default; \`${b} decision search "<terms>"\`
surfaces prior decisions, so check for precedent before re-deciding. ${decidePointer}${computerPointer}`;
}

// ── Skills ──────────────────────────────────────────────────────────────────

/** A shipped skill: its adapter-relative file path + a bin-name-aware renderer. */
export interface SkillTemplate {
  id: string;
  /** path under the adapter skill dir, e.g. `harn-decide/SKILL.md` */
  relPath: string;
  render: (binName: string) => string;
  /**
   * Config gate for an opt-in skill. `"computer"` renders only when the project
   * turns computer on (`mode` other than "off", or `enabled: true`); ungated skills always render (minus
   * `skills.exclude`).
   */
  optIn?: "computer";
}

function decideBody(b: string): string {
  return `The decision docket is a persistent queue for decisions you would otherwise
route to a human. It's built on the \`${b} decision\` engine. This skill is the
mechanics: file, find precedent, claim, and resolve with evidence. *When* a
decision needs a human at all (versus one you settle yourself) is host policy;
if this project defines that rubric, follow it.

## Modes

- **A decision you're facing (default)** → capture: record it and proceed.
- **\`resolve <id>\`** → pick up an open decision, research it, resolve it.
- **\`review\`** → surface resolved-but-unreviewed decisions for a human to skim.

## Capture (default)

1. **Check precedent first.** \`${b} decision search "<key terms>"\`. If a resolved
   decision already answers this, cite it; don't re-litigate.
2. **File it** when the choice has a second consumer (a human will want to see it,
   or a future agent will face it again) or reversal is expensive. Skip the
   docket for pure local mechanics (a variable name, one of two equivalent idioms).

   \`\`\`bash
   ${b} decision file "<the decision as a clear question>" \\
     --context "why it matters / what's blocked / the options you see" \\
     --default-taken "<what you're proceeding with>"
   \`\`\`

   For a decision with real substance, write a brief to a file and pass
   \`--brief <path>\` so the reviewer sees options + evidence, not a cold prompt.
3. **Proceed on your default.** Filing does not mean blocking. Note the id in your
   reply and keep working.

## Resolve (\`resolve <id>\`)

\`\`\`bash
${b} decision show <id>     # read the question + context + any brief
${b} decision claim <id>    # mark it deliberating (claimed by you)
\`\`\`

Research it for real: run the queries, read the files, compute the costs. Then
resolve with **cited evidence** (the engine rejects an evidence-free resolution):

\`\`\`bash
${b} decision resolve <id> \\
  --recommendation "<the call>" \\
  --evidence "<a fact you established: a query run, a file read, a cost computed>" \\
  --evidence "<another>" \\
  --reversal-cost "<cost to undo if wrong>" \\
  --wrong-if "<what would make this wrong>" \\
  --revisit-when "<trigger to revisit>"
\`\`\`

If the decision is genuinely hard or contested, leave it open with a brief that
lays out the options and evidence rather than forcing a thin single-agent
resolution.

## Review (\`review\`)

\`\`\`bash
${b} decision list --status resolved
\`\`\`

For each one a human reacts to, record the verdict so triage self-corrects:

\`\`\`bash
${b} decision review <id> --verdict ratified              # agreed; no action
${b} decision review <id> --verdict overridden --note "…" # disagreed
${b} decision review <id> --verdict wrong-tier-low        # "didn't need to see this"
${b} decision review <id> --verdict wrong-tier-high       # "should have seen it sooner"
\`\`\``;
}

function endBody(b: string): string {
  return `Finalize only after the work is genuinely complete. This is the deliberate,
high-confidence escape hatch for adapters that do not provide a trustworthy
native session-end callback.

## Workflow

1. Finish all in-scope work, tests, documentation, commits, pushes, and
   user-facing reporting first.
2. Confirm no tool call, open turn, delegated child, file claim, or uncommitted
   session write remains. Do not fabricate completion or use this skill to hide
   unfinished work.
3. Run the closing status and end request as the final tool action:

   \`\`\`bash
   ${b} agents status --end-turn --end-session
   \`\`\`

   When automatic identity resolution is unavailable, pass the current native
   adapter session ID with \`--session-id <id>\`. The command durably queues the
   authoritative end while it is still running. The adapter's stop hook records
   \`session.ended\` only after this command, its tool span, and the current turn
   have closed.
4. Do not run another tool after a successful request. Reproduce the status
   output, tell the operator the end is queued, and yield. The terminal event ID
   becomes available after the response completes and can be verified from a
   later session or the web UI.

## Refusals and recovery

- If the command reports delegated work, finish or explicitly cancel those
  children, then try again.
- If Git finalization fails, complete the repository's required commit and push
  workflow before retrying.
- If the V3 ledger is unavailable or unsafe, do not fall back to deleting a
  projection or writing a synthetic ledger row. Report the failure.
- Starting a new turn or tool after the request cancels the pending end. Run the
  workflow again when the session is actually finished.
- On a manual \`${b} agents end\` call, use \`--outcome failed\`, \`cancelled\`,
  \`interrupted\`, or \`unknown\` only when that describes the completed session
  honestly.

Never use this skill to end another operator's session unless the operator
explicitly identifies it. Use the web control or \`${b} agents end --instance-id
<id>\` for that operator action; it records immediately for an idle session or
durably queues the end for its current turn.`;
}

function computerBody(b: string): string {
  return `\`${b} computer\` drives this machine's desktop through two pinned desktop drivers.
It is one of several ways to work with pages and programs, and the person's
attention is the scarce resource: invisible work beats a window they did not
need, and a result in the chat beats a window somewhere else.

## Choose the route

Decide what the task is, then how to do it, then how the person receives
it. These are separate choices: a result the person should see does not by
itself call for the desktop.

**Before starting**, work out the whole task and check quietly which routes
work (an API, a file, a sign-in the browse profile already holds). Then ask
once, in the chat, for everything the task needs: any sign-ins, the desktop
approval if a window is unavoidable, and any approval to change or send
something, each named. Say before a pop-up or a window appears that it is
coming.

**How to do it**, most invisible first, one try per route:

1. An API, a CLI command or the file itself.
2. Reading a page: \`${b} fetch\` for public pages; headless \`${b} browse\` for
   pages that need JavaScript or a sign-in.
3. Changing something in a web app or outside system: prepare it in the
   chat first, then make the change through its API or headless
   \`${b} browse\` once the person approved it (below).
4. A sign-in is missing or expired: run \`${b} browse --login --detach <url>\`,
   which returns once a separate Chrome window is open, and pass its
   sentence on to the person. When they say they are done, read the log it
   named and continue. If \`${b} computer status\` shows \`sign-in: on\`, you
   may sign in in that window yourself instead, the way "Signing in for the
   person" below describes. After a bot check or an unusual-sign-in warning,
   stop and tell them; never retry it automatically.
5. The desktop (\`${b} computer\`) only for a desktop program with no file or
   API route, a site that refuses the headless browser even when signed in,
   or work the person will continue in a state no link can hand them.
6. Your agent app's own browser, last: a browser pane built into the app,
   or the app's connection that drives the person's Chrome. In the Codex app
   that means its browser and computer-use tools (tabs in the connected
   Chrome, and opening a page beside the chat); in Claude Desktop, its
   browser pane tools. Use one only after every route above failed. Before
   the first call, ask in the chat and wait for a yes: listing or reading
   the person's open tabs already counts as using their browser, and a tab
   left open by earlier work is no exception. Never use one for a sign-in;
   a sign-in goes through step 4.
7. Nothing worked: stop, deliver what you found, and say plainly what could
   not be done. Never climb to a riskier tool on your own.

A request for a result is not a request to build a tool. When no command or
integration reaches the system the task needs, say so and ask before writing
one; never commit or push a new one unasked.

An automation-controlled window (\`${b} browse --headed\`,
\`${b} browse --login --attached\`) is only for what Playwright alone gives you
in a window, such as a scripted batch with assertions, a HAR capture or
viewport emulation, and never on an outside account.

**How the person receives it**, in the chat first:

- An answer in plain words, or the headline plus a link to the full result.
- A web page as a link, one that reproduces the state (search terms,
  filters) when the site allows. Open it in their browser only when they
  ask to open or see it now; "show me" counts as asking. Open it with
  \`${b} open <url>\`, which uses the default browser, not a browser pane in
  your app.
- A state no link can reproduce as a picture of just that part, checked
  before sending, with a sentence saying what it shows. Some chat apps show
  a local picture only as a link (Claude Desktop's Code tab does; the Codex
  app shows it inline), so the sentence must carry the point on its own.
- Work they will continue as a link to the prepared state in their own
  browser, where they are already signed in; a desktop window only when no
  link can do it and they agreed to take it over.
- A step only they may take (a sign-in, a one-time code, a signature, an
  unapproved message) left ready, with exactly what to press and why.

**Three approvals stay separate.** The desktop approval (\`grant\`, below)
covers using the screen for one purpose, nothing more. Changing anything in
an outside system needs the person's approval before the first change:
creating a draft, filling a field that saves itself, or uploading a file
already counts. Anything that notifies a person (a send, an invitation, a
form submission, a signature request) needs approval for that recipient and
purpose; once approved, finish it yourself and check that it went through.

## Setup check

\`\`\`bash
${b} computer status
\`\`\`

It shows the approval mode, the host, each pinned driver and whether it is
installed, any daemon, and who holds the desktop. When a driver is missing,
run \`${b} computer install --yes\` (both) or add \`--driver <id>\`.
\`${b} computer doctor\` reports each driver's own health checks, including
missing OS permissions.

## Two drivers

Both drive the same desktop under the same lease. \`--driver <id>\` picks one
for \`call\`, \`tools\` and \`describe\`; without it you get the project's default
(\`status\` marks it).

- **\`agent-desktop\`**: reads an app's accessibility tree as a snapshot and
  acts on refs from that snapshot. Compact, headless by default, and a stale
  ref fails instead of hitting the wrong element. Start here for reading and
  operating native app UI: buttons, fields, menus, lists, settings.
- **\`cua\`**: tool calls with element tokens, pixel and keyboard routes,
  window screenshots, and an isolated browser through CDP. Use it for a
  browser task, when you need to see pixels, or when agent-desktop refuses an
  action or cannot see the control.

Refs and tokens belong to the driver that produced them; never pass one
driver's ref to the other.

## Approval

The mode in \`status\` says how much the person must approve: \`off\`,
\`ask-each-task\`, \`ask-once-per-session\`, or \`on\`. The project sets the default
and each person may choose their own. In an ask mode, \`call\` refuses (exit 4)
until you hold an approval:

\`\`\`bash
${b} computer grant --purpose "<what you will do, in plain words>"
\`\`\`

The person answers a Yes/No prompt; no answer counts as no. Name one real
purpose and stay inside it; ask again when the purpose changes. If they say no,
do not use the desktop: tell them what you needed it for. When the task is
finished, end the approval and free the desktop:

\`\`\`bash
${b} computer done
\`\`\`

Never change the mode, edit the approval files, or run the driver directly to
get around a refusal. The approval is a promise to the person, not a lock.

## Core loop: agent-desktop

Every step is one call: \`${b} computer call --driver agent-desktop <command> '<json>'\`.
JSON keys are the command's snake_case field names (\`--window-id\` becomes
\`window_id\`, a ref is \`ref_id\`). \`${b} computer describe --driver agent-desktop <command>\`
lists them; \`describe --driver agent-desktop skill:desktop\` prints the full
loop and retry rules from the binary itself.

1. **Find the app**: \`list-apps\`, or \`launch\` with \`{"app": "<name>"}\`.
2. **Snapshot**: \`snapshot\` with \`{"app": "<name>", "interactive_only": true}\`.
   For a dense app, add \`"skeleton": true\` first, then snapshot one region
   with \`"root": "<ref>"\`.
3. **Act on a ref** such as \`"@s8f3k2p9:e8"\` from the latest snapshot:
   \`click\`, \`set-value\` (\`{"ref_id": ..., "value": ...}\`), \`toggle\`, \`select\`.
   Prefer \`set-value\` to \`type\`, which needs \`"headed": true\` on Windows.
4. **Read back** with \`get\` or a fresh snapshot. On \`STALE_REF\` or
   \`AMBIGUOUS_TARGET\`, snapshot again; retry only when the error's
   \`disposition.retry\` is \`safe\`.

If a packaged app (Calculator, Settings) fails by name with \`APP_NOT_FOUND\`,
get its window id from \`list-windows\` and pass \`window_id\` instead.

\`launch\` returns once the process runs, before any window exists. If the next
snapshot fails with \`WINDOW_NOT_FOUND\`, the app has not drawn a window; some
(Calculator on macOS) draw none until activated. Launch it with cua's
\`launch_app\`, which stays in the background, or pass \`"activate": true\`,
which brings it to the front.

On macOS, \`set-value\` and headless \`type\` change a document's text without the
app marking it edited, so a later save writes nothing (the result says
\`application_commit: not_verified\`). To edit a document you will save, use
cua's \`set_value\`, which registers the edit.

Pass \`"headed": true\` only when a command refuses headless delivery: it moves
the pointer and takes focus from the person.

## Core loop: cua

Every step is one call: \`${b} computer call --driver cua <tool> '<json>'\`. Look up a tool's
arguments with \`${b} computer describe --driver cua <tool>\` rather than guessing; \`${b} computer tools --driver cua\`
lists them.

1. **Launch** the app in the background with \`launch_app\`.
2. **Read state** with \`get_window_state\` and \`include_screenshot: false\`. When
   you need to see the window, pass \`screenshot_out_file\` with a file path
   and read that file. Inline screenshots are redacted from the output unless
   you pass \`--keep-screenshot\`, because they flood your context.
3. **Act by element token** \`"<snapshot_id>:<row>"\` from the latest state:
   click, \`set_value\`, or invoke, batched through \`run_steps\` when several
   actions belong together.
4. **Read back** the state after acting. Confirm the change landed before you
   retry anything; never repeat an action blind.

## Rules

- Prefer accessibility routes (agent-desktop refs; cua \`set_value\` and
  invoke) over typing and coordinate clicks.
- Never pass cua's \`delivery_mode: "foreground"\` unless the driver returned
  \`background_unavailable\` or \`delivery_failed\` for that action.
- For a browser page that needs no sign-in, use cua's \`browser_prepare\` with
  \`allow_launch: true\` and \`profile: {"mode": "isolated_new"}\`. The driver
  controls that browser through the DevTools protocol, and sites can tell.
- Never ask the person to sign in to an outside account (Google, a vendor, a
  bank) inside a driver-owned isolated browser: sites flag it as automation,
  show bot checks, and may lock the account. When the task needs the person's
  signed-in session, ask whether you may work in their running browser, and
  only on a yes drive its window the way a screen reader does: agent-desktop
  refs, or cua element tokens from \`get_window_state\` on that window. That
  route attaches nothing, so sites see the person's own browser. Open a new
  tab rather than taking over theirs, and if a page needs a sign-in, the person
  signs in there unless they let agents do it (below). cua's \`browser_prepare\` with
  \`strategy: {"kind": "existing_profile"}\` needs a driver-level grant that
  covers every agent on the machine, so do not ask for it to save a step.
- Never type a password, username, or one-time code into a sign-in page
  yourself.
- An approval to use the desktop is not approval to communicate. Never click
  Send, Reply, Post, Share, Accept, or Submit, or press Enter in a compose
  field, unless the operator approved that specific message.
- Everything you capture can reach your model provider. Before the first
  capture, check what is on screen; if something the person would not want
  sent is open (a private document or mail, a password manager, a filled
  sign-in form), ask them to close it first. Prefer one window over the
  full screen.
- Only close apps you launched (cua \`kill_app\`, agent-desktop \`close-app\`).

## Signing in for the person

Off by default: the person signs in. When \`${b} computer status\` shows
\`sign-in: on\`, they let agents sign in to websites for them
(\`${b} computer sign-in\`, or the dashboard's Permissions page). Then, in
their running browser through the screen-reader route above, or in a
\`${b} browse --login --detach\` window:

1. Open the sign-in page in a new tab.
2. Open their password manager's browser extension and choose the login
   that matches the site, so it fills the username, password and any
   one-time code. Never type any of them yourself.
3. A locked password manager, a passkey, a hardware key, a system prompt
   (Windows Hello, Touch ID), a code sent by email or text, or a window with
   no password manager goes to the person, with exactly what to press.

Even with sign-in on, never sign in inside an isolated or
automation-controlled browser (\`--headed\`, \`--attached\`, a driver-owned
browser), and never in your agent app's own browser. After a bot check or an
unusual-sign-in warning, stop and tell the person; never retry it
automatically.

## One desktop, one holder

Every agent on this machine shares one desktop. \`call\` takes a lease for you
and refreshes it on every call; it lapses after a short idle period.

- A refusal naming another holder means **wait**, then try once more later. Do
  not retry in a loop. \`--wait <seconds>\` waits longer on one call.
- Check the holder with \`${b} computer lease status\`.
- Release the desktop as soon as you finish (\`${b} computer done\` also ends
  your task approval):

  \`\`\`bash
  ${b} computer lease release
  \`\`\`

Report what you did on the desktop, which apps you launched and closed, and
anything you left open.`;
}

export const SKILLS: SkillTemplate[] = [
  {
    id: "harn-decide",
    relPath: "harn-decide/SKILL.md",
    render: (binName) =>
      buildOwnedSkill({
        name: "harn-decide",
        description:
          "File a decision into the docket instead of blocking on a human: search precedent, file it, and proceed on a reversible default; or pick up and resolve an open decision with cited evidence. Use whenever you're about to ask a human a decision-shaped question you could resolve yourself.",
        binName,
        body: decideBody(binName),
      }),
  },
  {
    id: "harn-end",
    relPath: "harn-end/SKILL.md",
    render: (binName) =>
      buildOwnedSkill({
        name: "harn-end",
        description:
          "Safely finalize the current Harnery agent session with an authoritative V3 session-ended event. Use when the operator says /harn-end, asks to end or close the current session, or when all work is complete and the session should stop counting as live.",
        binName,
        body: endBody(binName),
      }),
  },
  {
    id: "harn-computer",
    relPath: "harn-computer/SKILL.md",
    optIn: "computer",
    render: (binName) =>
      buildOwnedSkill({
        name: "harn-computer",
        description:
          "Choose how to work with web pages and desktop programs, and drive a native desktop app or a real browser through the project's two pinned desktop drivers (agent-desktop snapshots and refs; cua tools, screenshots and isolated browser). Covers the routing (invisible work first, results in the chat, the desktop only when a window is unavoidable), the three separate approvals, the setup check, which driver to pick, each driver's read / act / read back loop, safety rules, and the shared desktop lease.",
        binName,
        body: computerBody(binName),
      }),
  },
];
