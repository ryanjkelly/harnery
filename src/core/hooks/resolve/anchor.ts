/**
 * Pure pid-map anchor selection: picks which PID in a process's ppid chain
 * the heartbeat pid-map row should be keyed to, so the agent's later shell
 * tool calls (which ppid-walk up to find it) resolve their own identity.
 *
 * Split out of cli.ts's `findHarnessAnchorPid` so the comm-matching logic is
 * unit-testable against the real Phase 0 Cursor probe chains without needing a
 * live /proc tree.
 *
 * Why the cursor `node` fallback exists: Cursor's WSL/Linux process tree has
 * NO process named `cursor`: the chain is `bash → bash → node → node → sh →
 * Relay → init`. The `node` ancestors are stable across every hook + tool event
 * in one IDE-window session, so anchoring there gives the agent's shell tool
 * calls a reachable, stable pid-map row. This faithfully restores the previous
 * cursor anchor behavior (match `cursor` first, then fall back to `node`) that
 * was dropped in the Phase 4-6 TS refactor, the same regression class as the
 * heartbeat-platform + pidmap-self-heal losses. Scoped to `harness === "cursor"`
 * so Claude Code / Codex never
 * mis-anchor on an unrelated `node` ancestor (they match their own comm token
 * directly).
 *
 * Known limitation (matches the bash original): two Cursor chats sharing one
 * IDE window share their `node` ancestor, so the pid-map row is last-writer-
 * wins between them. Single-chat-per-window (the common case) is correct;
 * concurrent same-window chats disambiguate via `--session-id`.
 */

/** Harness-binary comm names. CC's tool calls descend from `claude`, Codex's
 * from `codex`; matched directly so neither needs the `node` fallback. */
const PRIMARY_COMM_TOKENS = new Set(["claude", "claude-code", "cursor", "codex"]);

/**
 * Pick the anchor PID from a ppid chain ordered nearest-first (the resolving
 * process at index 0, walking up toward init). Returns the first ancestor
 * matching a harness comm token; for cursor, falls back to the first `node`
 * ancestor; otherwise undefined (caller falls back to process.ppid).
 */
export function selectAnchorPid(
  chain: ReadonlyArray<{ pid: number; comm: string }>,
  harness?: string,
): number | undefined {
  for (const hop of chain) {
    if (PRIMARY_COMM_TOKENS.has(hop.comm)) return hop.pid;
  }
  if (harness === "cursor") {
    for (const hop of chain) {
      if (hop.comm === "node") return hop.pid;
    }
  }
  return undefined;
}
