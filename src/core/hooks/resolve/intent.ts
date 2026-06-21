import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve the model-declared intent for the current tool call. Three-source
 * precedence:
 *
 *   1. `# intent: X` comment on the first line of the bash command.
 *   2. `description` field on the tool input (Claude Code only).
 *   3. `<intent>...</intent>` tag in the most-recent assistant prose, read
 *      from `.harnery/.last-intent.<instance_id>` (the bash bash-tap is the
 *      only thing that does transcript scanning today; agent-hook stamps the
 *      file on precedence 1/2 so the bash-tap can fall back to it).
 *
 * Phase 8 (2026-05-27): agent-hook writes the stamp file itself on precedence
 * 1/2 (replacing coord-intent-stamp.sh's command/description branches). The
 * transcript-tag branch is now the only thing left in coord-intent-stamp.sh.
 */
export function resolveIntent(opts: {
  coordRoot: string;
  instanceId: string;
  /** First-line `# intent: X` comment from the bash command (preferred fresh source). */
  commandIntentComment?: string;
  /** `description` field on the tool input (Claude Code only). */
  description?: string;
}): { intent: string; source: "command-comment" | "description" | "stamp" | "none" } {
  const stampPath = join(opts.coordRoot, ".harnery", `.last-intent.${opts.instanceId}`);

  // 1. Fresh from the command itself (most reliable, cross-harness).
  if (opts.commandIntentComment) {
    const cleaned = clamp(opts.commandIntentComment);
    if (cleaned) {
      writeStamp(stampPath, cleaned);
      return { intent: cleaned, source: "command-comment" };
    }
  }

  // 2. Fresh from the tool input description (Claude Code only).
  if (opts.description) {
    const cleaned = clamp(opts.description);
    if (cleaned) {
      writeStamp(stampPath, cleaned);
      return { intent: cleaned, source: "description" };
    }
  }

  // 3. Whatever the bash-tap stamped from a transcript <intent> tag.
  if (existsSync(stampPath)) {
    try {
      const stamped = readFileSync(stampPath, "utf8").trim();
      if (stamped && stamped !== "(no intent)") {
        return { intent: stamped, source: "stamp" };
      }
    } catch {
      /* fallthrough */
    }
  }

  return { intent: "(no intent)", source: "none" };
}

function writeStamp(path: string, value: string): void {
  try {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, value, "utf8");
    renameSync(tmp, path);
  } catch {
    /* best-effort */
  }
}

/**
 * Match `# intent: X` at the start of a command (after optional leading
 * whitespace on the first line). Mirrors `extract_command_intent_comment` in
 * coord-intent-stamp.sh.
 */
export function extractIntentComment(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const firstLine = command.split("\n", 1)[0];
  const m = firstLine?.match(/^[ \t]*#[ \t]*intent:[ \t]*(.+)$/);
  if (!m) return undefined;
  return m[1]?.trimEnd();
}

function clamp(v: string): string {
  const trimmed = v.trim();
  if (trimmed.length <= 200) return trimmed;
  return `${trimmed.slice(0, 197)}...`;
}
