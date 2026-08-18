export interface OpenToolSpanForCommandParent {
  span_id: `span_${string}`;
  turn_id?: `tid_${string}`;
  requested_event_id?: `evt_${string}`;
  tool_name?: string;
}

const SHELL_TOOL_NAMES = new Set([
  "apply_patch",
  "bash",
  "exec",
  "exec_command",
  "execute",
  "powershell",
  "run_command",
  "shell",
  "terminal",
]);

/**
 * Choose a command's tool parent only when attribution cannot silently pick
 * the wrong span. A single open tool is unambiguous. With parallel tools,
 * exactly one shell-class span may be selected; every other case stays
 * top-level so any over-count remains visible.
 */
export function selectCommandParentSpan(
  spans: readonly OpenToolSpanForCommandParent[],
  turnId: `tid_${string}`,
): `span_${string}` | undefined {
  const open = spans.filter(
    (span) => span.turn_id === turnId && span.requested_event_id !== undefined,
  );
  if (open.length === 1) return open[0]?.span_id;
  const shell = open.filter((span) => isShellToolName(span.tool_name));
  return shell.length === 1 ? shell[0]?.span_id : undefined;
}

export function isShellToolName(name: string | undefined): boolean {
  if (!name) return false;
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/^.*[.:/]/, "")
    .replaceAll("-", "_");
  return SHELL_TOOL_NAMES.has(normalized);
}
