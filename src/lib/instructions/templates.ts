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

import { SCRATCH_CATEGORIES } from "../../core/scratch/index.ts";
import { buildOwnedSkill } from "./splice.ts";

/** Managed-region name for the AGENTS.md orientation block. */
export const INSTRUCTIONS_REGION = "instructions";
/** Managed-region name for the CLAUDE.md `@AGENTS.md` import shim. */
export const IMPORT_REGION = "import";

/** Which shipped skills exist in the project the block is rendered for. */
export interface BlockSkills {
  /** the `harn-decide` skill file is present (claude-code, not excluded) */
  decide: boolean;
  /** the `harn-council` skill file is present */
  council: boolean;
}

/**
 * The always-on orientation spliced into `AGENTS.md`. Target ≤ 80 rendered
 * lines: it costs every agent context on every turn, so it states that each
 * surface *exists* and gives one line of *when* — the *how* lives in the skills
 * and each command's `--help`. Skill names are fixed (`harn-decide`,
 * `harn-council`) even for a renamed bin; only command strings track `binName`.
 *
 * The block only points at a skill that actually exists here: a host that
 * excludes one via `skills.exclude`, or a harness with no skill primitive
 * (cursor/codex get the block but no skill files), gets a `--help` pointer
 * instead of a dangling reference to a skill it doesn't have.
 */
export function renderInstructionsBlock(
  binName: string,
  skills: BlockSkills = { decide: true, council: true },
): string {
  const b = binName;

  const named = [skills.decide && "`harn-decide`", skills.council && "`harn-council`"].filter(
    Boolean,
  ) as string[];
  const deeper =
    named.length > 0
      ? `Procedures for the deeper flows live in the ${named.join(" and ")} skill${named.length > 1 ? "s" : ""}.`
      : `See \`${b} decision --help\` and \`${b} council --help\` for the deeper procedures.`;
  const decidePointer = skills.decide
    ? "The `harn-decide` skill has the file / claim / resolve-with-evidence procedure."
    : `See \`${b} decision --help\` for the file / claim / resolve-with-evidence procedure.`;
  const councilPointer = skills.council
    ? "The `harn-council` skill has the steward and member flow."
    : `See \`${b} council --help\` for the steward and member flow.`;
  // Render the scratch categories from the canonical enum so this prose can
  // never drift from what `scratch add` actually accepts (the "note, plan…" list
  // silently lagged the tool by two categories before this).
  const scratchCats =
    SCRATCH_CATEGORIES.length > 1
      ? `${SCRATCH_CATEGORIES.slice(0, -1).join(", ")}, or ${SCRATCH_CATEGORIES.at(-1)}`
      : SCRATCH_CATEGORIES[0];

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

**Durable role handoff.** When you are replacing a prior session in the same
named role, run \`${b} agents identity assume <name>\` before declaring your task.
It reclaims an abandoned namesake (no live process) and refuses only when another
live process still holds the name; never hand-edit Harnery's history, heartbeat,
or derived identity cache.

**Declare intent on shell commands.** Every command you run is captured to the
coordination ledger. Lead a shell command with a \`# intent: <why>\` comment (or set
the tool's description) so the recorded event carries a reason instead of
\`(no intent)\`.

**Scratch journal.** \`${b} scratch add <category> "<text>"\` (category = ${scratchCats})
leaves breadcrumbs that survive context compaction;
\`${b} scratch read\` reads yours, \`${b} scratch read --name <peer>\` reads a peer's.
Use it for anything future-you or a peer will need to pick up your thread.

**Decision docket.** When you would otherwise stop to ask a human a decision you
can't resolve from the repo, file it instead. \`${b} decision file "<question>"\`
records it and lets you proceed on a stated default; \`${b} decision search "<terms>"\`
surfaces prior decisions, so check for precedent before re-deciding. ${decidePointer}

**Councils.** For a hard or contested decision, convene a council of agents.
\`${b} council create "<objective>"\` runs structured rounds toward a decision. ${councilPointer}`;
}

// ── Skills ──────────────────────────────────────────────────────────────────

/** A shipped skill: its harness-relative file path + a bin-name-aware renderer. */
export interface SkillTemplate {
  id: string;
  /** path under the harness skill dir, e.g. `harn-decide/SKILL.md` */
  relPath: string;
  render: (binName: string) => string;
}

function decideBody(b: string): string {
  return `The decision docket is a persistent queue for decisions you would otherwise
route to a human. It's built on the \`${b} decision\` engine. This skill is the
mechanics — file, find precedent, claim, and resolve with evidence. *When* a
decision needs a human at all (versus one you settle yourself) is host policy;
if this project defines that rubric, follow it.

## Modes

- **A decision you're facing (default)** → capture: record it and proceed.
- **\`resolve <id>\`** → pick up an open decision, research it, resolve it.
- **\`review\`** → surface resolved-but-unreviewed decisions for a human to skim.

## Capture (default)

1. **Check precedent first.** \`${b} decision search "<key terms>"\`. If a resolved
   decision already answers this, cite it — don't re-litigate.
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
3. **Proceed on your default.** Filing does not mean blocking — note the id in your
   reply and keep working.

## Resolve (\`resolve <id>\`)

\`\`\`bash
${b} decision show <id>     # read the question + context + any brief
${b} decision claim <id>    # mark it deliberating (claimed by you)
\`\`\`

Research it for real — run the queries, read the files, compute the costs. Then
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

If the decision is genuinely hard or contested, escalate to a council
(\`${b} council create "<objective>"\`) and link it rather than forcing a thin
single-agent resolution.

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

function councilBody(b: string): string {
  return `A council convenes several agents to deliberate a hard or contested decision
over structured rounds. This skill wraps the \`${b} council\` surface with the
guardrails a router needs when passing prompts between agents. It's asymmetric on
purpose: it does the most for **contributors** (refusing a misrouted prompt) and
the least for **stewards**.

Every mode starts by running \`${b} agents whoami --json\` and, when an id is given,
\`${b} council show <id> --json\`, so the logic works against typed data, not text.

## Modes

- **No argument** → list councils you're a member of; surface what waits on you.
- **\`create <objective>\`** → open the web member-picker with the objective filled.
- **\`contribute <id>\`** → the guarded contribution flow (below).
- **\`prompts <id>\`** → steward: draft each pending member's routing prompt.
- **\`show <id>\`** → render council state verbatim.

## List (no arg)

\`\`\`bash
${b} agents whoami --json
${b} council list --mine --json
\`\`\`

One section per council you're a member of: id + objective, round N (open /
collected) with N/M contributors, and your status (awaiting prompt / prompt ready
/ already contributed) with the next command to run. Stop after listing — don't
auto-route into contribute.

## Create (\`create <objective>\`)

The web UI is the member + steward picker; don't create from the CLI (that skips
the steward choice). Emit the link with the objective URL-encoded:

\`\`\`
http://localhost:9000/councils/new?objective=<encoded>
\`\`\`

If the dev server isn't up, start it with \`${b} web up\`.

## Contribute (\`contribute <id>\`) — the guarded flow

Run these checks in order; refuse with a specific reason if any fails.

1. **Membership.** If your \`whoami\` name isn't in \`manifest.members\`, refuse — the
   router likely meant a different agent's session.
2. **Already contributed.** If you're in \`current_round_contributors\`, refuse —
   wait for the steward to advance the round.
3. **Prompt routing.** Find your entry in \`current_round_prompts\`. If none is
   drafted for you, refuse (the steward must write one first). If the routed body
   carries a \`<!-- council-route … member: <name> -->\` header naming a *different*
   agent, refuse — the wrong prompt was pasted into your session.
4. **Compose** per your prompt (read \`manifest.target_doc\` in full if set; strip
   the route header before treating the body as instructions).
5. **Submit:**

   \`\`\`bash
   ${b} council contribute <id> --message "<status-line>" --file <path>
   \`\`\`

   Use \`--file\` when you edited a target doc (captures the post-edit state);
   \`--message\` for a prose-only contribution. If the prompt asks for a
   substantive/trivial classification, end with the literal \`<substantive>\` or
   \`<trivial>\` angle-bracket tag on the final line (the exit-criterion parser keys
   on it). When in doubt, lean \`<trivial>\`.

## Prompts (\`prompts <id>\`) — steward

1. **Authority.** If your \`whoami\` name ≠ the council's \`steward\`, stop.
2. **Plan the round** from the target doc + prior rounds. Round 1 must include a
   completeness critic — assign one member the explicit charge: "What important
   thing is NOT in this document at all — a missing dimension, not a flaw in what's
   written?" Lens-scoped reviewers reliably miss whole absent dimensions.
3. **Draft + write** one prompt per member missing from \`current_round_prompts\`:

   \`\`\`bash
   ${b} council prompt <id> agent-<Name> --message "..."   # or --file <path>
   \`\`\`

   The CLI auto-prepends the \`<!-- council-route … -->\` header — never write it by
   hand. Every prompt must instruct the member to end with the literal
   \`<substantive>\` / \`<trivial>\` tag.

## Refusal style

Lead with what you are versus what the council expects, cite the structural fact
that triggered the refusal (member list, contributors, prompt absence, route
mismatch), and offer the right next step. Don't propose a workaround that bypasses
the guard.`;
}

export const SKILLS: SkillTemplate[] = [
  {
    id: "harn-decide",
    relPath: "harn-decide/SKILL.md",
    render: (binName) =>
      buildOwnedSkill({
        name: "harn-decide",
        description:
          "File a decision into the docket instead of blocking on a human — search precedent, file it, and proceed on a reversible default; or pick up and resolve an open decision with cited evidence. Use whenever you're about to ask a human a decision-shaped question you could resolve yourself.",
        argumentHint: "[<the decision / question you're facing> | resolve <id> | review]",
        binName,
        body: decideBody(binName),
      }),
  },
  {
    id: "harn-council",
    relPath: "harn-council/SKILL.md",
    render: (binName) =>
      buildOwnedSkill({
        name: "harn-council",
        description:
          "Interact with the multi-agent council system: list / create / show / prompts (steward) / contribute (member). Guards against misrouting — refuses to contribute when you aren't a member, have already contributed, or weren't routed a prompt.",
        argumentHint:
          "[<id-or-fragment> | create <objective> | contribute <id> | prompts <id> | show <id>]",
        binName,
        body: councilBody(binName),
      }),
  },
];
