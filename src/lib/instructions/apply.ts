/**
 * The fs side of ADR 0008: apply / remove / check harnery's machine-owned
 * agent-facing content in a consumer repo. `init` calls `applyInstructions`,
 * `deinit` calls `removeInstructions`, and `init --check` calls
 * `checkInstructions`. The pure splice mechanics live in `splice.ts` and the
 * rendered content in `templates.ts`; this module only sequences the reads,
 * writes, and deletes so init/deinit stay thin and this stays integration-
 * testable against a temp dir.
 *
 * Two files, one dir:
 *   - `AGENTS.md` — the always-on orientation block (a managed region; the
 *     consumer owns the rest of the file).
 *   - `CLAUDE.md` — claude-code only; Claude Code reads CLAUDE.md, not AGENTS.md,
 *     so a fresh consumer gets a CLAUDE.md whose managed region imports
 *     `@AGENTS.md`. A CLAUDE.md that already imports AGENTS.md or already carries
 *     the block (a host that generates CLAUDE.md from AGENTS.md) is left alone.
 *   - `.claude/skills/<skill>/SKILL.md` — claude-code only; fully-owned files,
 *     honoring `skills.exclude` in `.harnery/config.jsonc`.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { stripJsonComments } from "../../core/config.ts";
import {
  checkOwnedSkill,
  checkRegion,
  isOwnedFile,
  type ManagedStatus,
  removeRegion,
  spliceRegion,
} from "./splice.ts";
import {
  IMPORT_REGION,
  INSTRUCTIONS_REGION,
  renderInstructionsBlock,
  SKILLS,
} from "./templates.ts";

const AGENTS_FILE = "AGENTS.md";
const CLAUDE_FILE = "CLAUDE.md";
const CLAUDE_SKILLS_DIR = join(".claude", "skills");

/** CLAUDE.md import-shim body: points Claude Code (which reads CLAUDE.md, not AGENTS.md) at AGENTS.md. */
function importBody(): string {
  return "This project's agent instructions live in AGENTS.md.\n@AGENTS.md";
}

/** The body harnery expects for a skill's file (everything after the ownership marker). */
function skillBody(render: (bin: string) => string, binName: string): string {
  const content = render(binName);
  return content.slice(content.indexOf("-->") + 3).trim();
}

/** Read `skills.exclude` from `.harnery/config.jsonc` (absent/unparseable → none). */
export function readSkillsExclude(projectRoot: string): Set<string> {
  const p = join(projectRoot, ".harnery", "config.jsonc");
  try {
    const cfg = JSON.parse(stripJsonComments(readFileSync(p, "utf8"))) as {
      skills?: { exclude?: unknown };
    } | null;
    const ex = cfg?.skills?.exclude;
    if (Array.isArray(ex)) return new Set(ex.filter((x): x is string => typeof x === "string"));
  } catch {
    /* absent / unparseable → no exclusions */
  }
  return new Set();
}

interface ApplyOpts {
  binName: string;
  harness: string;
  dryRun: boolean;
}

export interface ApplyResult {
  actions: string[];
  warnings: string[];
}

/**
 * Inject / refresh the instructions block, the CLAUDE.md import shim (claude-code),
 * and the shipped skills (claude-code). Idempotent: a re-run on current content
 * writes nothing. `dryRun` reports without touching the fs.
 */
export function applyInstructions(projectRoot: string, opts: ApplyOpts): ApplyResult {
  const actions: string[] = [];
  const warnings: string[] = [];
  const claudeCode = opts.harness === "claude-code";
  // dry-run narrates the future ("would create"); a real run narrates the past.
  const verbed = (base: string, past: string) => (opts.dryRun ? `would ${base}` : past);

  // ── AGENTS.md orientation block ─────────────────────────────────────────
  const agentsPath = join(projectRoot, AGENTS_FILE);
  const agentsExisted = existsSync(agentsPath);
  const agentsBefore = agentsExisted ? readFileSync(agentsPath, "utf8") : "";
  const body = renderInstructionsBlock(opts.binName);
  const spliced = spliceRegion(agentsBefore, INSTRUCTIONS_REGION, body);
  if (!spliced.changed) {
    actions.push(`· ${AGENTS_FILE} instructions block already current`);
  } else {
    if (!opts.dryRun) writeFileSync(agentsPath, spliced.text);
    if (!agentsExisted)
      actions.push(`+ ${verbed("create", "created")} ${AGENTS_FILE} with the instructions block`);
    else if (!spliced.had)
      actions.push(`+ ${verbed("inject", "injected")} the instructions block into ${AGENTS_FILE}`);
    else actions.push(`~ ${verbed("update", "updated")} the instructions block in ${AGENTS_FILE}`);
  }

  // ── CLAUDE.md import shim (claude-code only) ────────────────────────────
  if (claudeCode) {
    const claudePath = join(projectRoot, CLAUDE_FILE);
    if (!existsSync(claudePath)) {
      const shim = spliceRegion("", IMPORT_REGION, importBody());
      if (!opts.dryRun) writeFileSync(claudePath, shim.text);
      actions.push(`+ ${verbed("create", "created")} ${CLAUDE_FILE} importing @AGENTS.md`);
    } else {
      const claude = readFileSync(claudePath, "utf8");
      const sees =
        claude.includes("@AGENTS.md") ||
        claude.includes(`harnery:begin ${IMPORT_REGION}`) ||
        claude.includes(`harnery:begin ${INSTRUCTIONS_REGION}`);
      if (sees) {
        actions.push(`· ${CLAUDE_FILE} already reaches AGENTS.md (left untouched)`);
      } else {
        warnings.push(
          `${CLAUDE_FILE} exists but neither imports @AGENTS.md nor carries the block; left ` +
            `untouched. For Claude Code to see the orientation, add \`@AGENTS.md\` to ${CLAUDE_FILE} ` +
            `(or generate ${CLAUDE_FILE} from ${AGENTS_FILE}).`,
        );
      }
    }
  }

  // ── shipped skills (claude-code only) ───────────────────────────────────
  if (claudeCode) {
    const exclude = readSkillsExclude(projectRoot);
    for (const skill of SKILLS) {
      if (exclude.has(skill.id)) {
        actions.push(`· skipped skill ${skill.id} (skills.exclude)`);
        continue;
      }
      const skillPath = join(projectRoot, CLAUDE_SKILLS_DIR, skill.relPath);
      const content = skill.render(opts.binName);
      const before = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : null;
      if (before === content) {
        actions.push(`· skill ${skill.id} already current`);
        continue;
      }
      if (!opts.dryRun) {
        mkdirSync(dirname(skillPath), { recursive: true });
        writeFileSync(skillPath, content);
      }
      const fresh = before === null;
      actions.push(
        `${fresh ? "+" : "~"} ${verbed(fresh ? "write" : "update", fresh ? "wrote" : "updated")} skill ${skill.id}`,
      );
    }
  }

  return { actions, warnings };
}

interface RemoveOpts {
  harness: string;
  dryRun: boolean;
}

/**
 * Reverse {@link applyInstructions}: strip the AGENTS.md block, the CLAUDE.md
 * import shim, and delete the shipped skill files (only ones harnery generated).
 * A file that becomes empty once our region is gone is deleted (init created it);
 * a hand-edited skill (no ownership marker) is left with a warning.
 */
export function removeInstructions(projectRoot: string, opts: RemoveOpts): ApplyResult {
  const actions: string[] = [];
  const warnings: string[] = [];
  const claudeCode = opts.harness === "claude-code";

  // ── AGENTS.md block ─────────────────────────────────────────────────────
  const agentsPath = join(projectRoot, AGENTS_FILE);
  if (existsSync(agentsPath)) {
    const { text, removed } = removeRegion(readFileSync(agentsPath, "utf8"), INSTRUCTIONS_REGION);
    if (!removed) {
      actions.push(`· no instructions block in ${AGENTS_FILE}`);
    } else if (text === "") {
      if (!opts.dryRun) rmSync(agentsPath);
      actions.push(`+ ${opts.dryRun ? "would remove" : "removed"} ${AGENTS_FILE} (was block-only)`);
    } else {
      if (!opts.dryRun) writeFileSync(agentsPath, text);
      actions.push(
        `+ ${opts.dryRun ? "would remove" : "removed"} the instructions block from ${AGENTS_FILE}`,
      );
    }
  }

  // ── CLAUDE.md import shim (claude-code) ─────────────────────────────────
  if (claudeCode) {
    const claudePath = join(projectRoot, CLAUDE_FILE);
    if (existsSync(claudePath)) {
      const { text, removed } = removeRegion(readFileSync(claudePath, "utf8"), IMPORT_REGION);
      if (removed) {
        if (text === "") {
          if (!opts.dryRun) rmSync(claudePath);
          actions.push(
            `+ ${opts.dryRun ? "would remove" : "removed"} ${CLAUDE_FILE} (was shim-only)`,
          );
        } else {
          if (!opts.dryRun) writeFileSync(claudePath, text);
          actions.push(
            `+ ${opts.dryRun ? "would remove" : "removed"} the import shim from ${CLAUDE_FILE}`,
          );
        }
      }
    }
  }

  // ── shipped skills (claude-code) ────────────────────────────────────────
  if (claudeCode) {
    for (const skill of SKILLS) {
      const skillPath = join(projectRoot, CLAUDE_SKILLS_DIR, skill.relPath);
      if (!existsSync(skillPath)) continue;
      if (!isOwnedFile(readFileSync(skillPath, "utf8"))) {
        warnings.push(`left ${skill.relPath} (hand-edited; no harnery ownership marker)`);
        continue;
      }
      if (!opts.dryRun) {
        rmSync(skillPath);
        // drop the now-empty skill dir (harn-decide/), leaving .claude/skills/ intact
        const dir = dirname(skillPath);
        try {
          if (readdirSync(dir).length === 0) rmdirSync(dir);
        } catch {
          /* dir not empty or gone → leave it */
        }
      }
      actions.push(`+ ${opts.dryRun ? "would delete" : "deleted"} skill ${skill.id}`);
    }
  }

  return { actions, warnings };
}

export interface CheckResult {
  status: "fresh" | "drift" | "error";
  issues: string[];
}

/**
 * Read-only drift report for `init --check`: the AGENTS.md block and each
 * shipped skill (claude-code). Fresh → exit 0; any stale / missing / hand-edit
 * → drift (exit 2); an unreadable file → error (exit 1). Mirrors the wiki-theme
 * `--check-only` contract the first host wires into pre-commit.
 */
export function checkInstructions(
  projectRoot: string,
  opts: { binName: string; harness: string },
): CheckResult {
  const issues: string[] = [];
  let errored = false;

  const note = (label: string, status: ManagedStatus) => {
    if (status === "missing") issues.push(`${label}: missing`);
    else if (status === "stale") issues.push(`${label}: stale (re-run init)`);
  };

  try {
    const agentsPath = join(projectRoot, AGENTS_FILE);
    const content = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
    note(
      `${AGENTS_FILE} block`,
      checkRegion(content, INSTRUCTIONS_REGION, renderInstructionsBlock(opts.binName)),
    );

    if (opts.harness === "claude-code") {
      const exclude = readSkillsExclude(projectRoot);
      for (const skill of SKILLS) {
        if (exclude.has(skill.id)) continue;
        const skillPath = join(projectRoot, CLAUDE_SKILLS_DIR, skill.relPath);
        const c = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : "";
        note(`skill ${skill.id}`, checkOwnedSkill(c, skillBody(skill.render, opts.binName)));
      }
    }
  } catch (err) {
    errored = true;
    issues.push(`error reading instructions state: ${(err as Error).message}`);
  }

  if (errored) return { status: "error", issues };
  return { status: issues.length === 0 ? "fresh" : "drift", issues };
}
