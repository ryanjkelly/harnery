/**
 * Write targets named by a file-writing tool call.
 *
 * Callers pass the adapter's parsed `tool_input`, never the event record's
 * copy. The event copy is JSON clamped to 8000 characters for the ledger, so
 * a Write or a Codex patch larger than that is cut mid-string, no longer
 * parses, and yields no path. The pre-tool guard then acquired no claim and
 * skipped the peer-conflict check for every large write. On 2026-11-13 four
 * of five new files written in one session went unclaimed this way, so the
 * end-of-turn check never asked for them to be committed.
 */

const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "StrReplace"]);

/** The tool input as an object. A JSON string is accepted for adapters that deliver one. */
function inputObject(toolInput: unknown): Record<string, unknown> | null {
  if (typeof toolInput === "string") {
    try {
      const parsed: unknown = JSON.parse(toolInput);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : null;
}

/** The single file path of an Edit, Write, NotebookEdit, or StrReplace call. */
export function writeToolFilePath(toolInput: unknown): string | undefined {
  const input = inputObject(toolInput);
  if (!input) return undefined;
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Paths named by a Codex `apply_patch` body's `*** Add|Update|Delete File:`
 * lines. The body arrives either as the bare patch text or in a `patch`,
 * `input`, or `command` field, the same shapes line counting accepts.
 */
export function applyPatchPaths(toolInput: unknown): string[] {
  let body: unknown;
  if (typeof toolInput === "string" && toolInput.trimStart().startsWith("*** Begin Patch")) {
    body = toolInput;
  } else {
    const input = inputObject(toolInput);
    body = input?.patch ?? input?.input ?? input?.command;
  }
  if (typeof body !== "string" || !body) return [];
  const out: string[] = [];
  const re = /^\s*\*\*\* (Add|Update|Delete) File:\s*(.+)$/gm;
  let m: RegExpExecArray | null = re.exec(body);
  while (m !== null) {
    out.push(m[2]!.trim());
    m = re.exec(body);
  }
  return out;
}

/** Candidate write targets for the pre-tool guard. Empty for a non-write tool or a call with no path. */
export function writeToolTargets(toolName: string, toolInput: unknown): string[] {
  if (WRITE_TOOLS.has(toolName)) {
    const target = writeToolFilePath(toolInput);
    return target ? [target] : [];
  }
  if (toolName === "apply_patch") return applyPatchPaths(toolInput);
  return [];
}
