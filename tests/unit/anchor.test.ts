/**
 * Locks pid-map anchor selection, in particular the cursor `node`-ancestor
 * fallback that lets a Cursor agent's shell tool calls resolve their own
 * identity (without it, `harn agents status` / `set-task` fail with
 * no_pidmap_entry). Chains below are the REAL Phase 0 Cursor probe ppid chains
 * from docs/api/cursor-hooks/samples/{sessionStart,postToolUse-shell}.json.
 */

import { describe, expect, test } from "bun:test";
import { parsePsChainLine, selectAnchorPid } from "../../src/core/hooks/resolve/anchor.ts";

// Phase 0 probe: Cursor's chain has no `cursor`-named process; the stable
// anchors are the `node` ancestors (70826 nearest, then 45290).
const CURSOR_POST_TOOL_USE_CHAIN = [
  { pid: 82655, comm: "bash" },
  { pid: 82652, comm: "bash" },
  { pid: 70826, comm: "node" },
  { pid: 45290, comm: "node" },
  { pid: 45278, comm: "sh" },
  { pid: 45171, comm: "Relay(45172)" },
  { pid: 1, comm: "init(Ubuntu-22." },
];

// Claude Code: the `claude` binary sits in the chain and is matched directly.
const CLAUDE_CHAIN = [
  { pid: 5001, comm: "bash" },
  { pid: 5000, comm: "node" },
  { pid: 4900, comm: "claude" },
  { pid: 1, comm: "init" },
];

describe("selectAnchorPid", () => {
  test("cursor: falls back to the first `node` ancestor (the stable IDE-session PID)", () => {
    expect(selectAnchorPid(CURSOR_POST_TOOL_USE_CHAIN, "cursor")).toBe(70826);
  });

  test("cursor: returns undefined when there is no `node` ancestor", () => {
    const noNode = [
      { pid: 10, comm: "bash" },
      { pid: 1, comm: "init" },
    ];
    expect(selectAnchorPid(noNode, "cursor")).toBeUndefined();
  });

  test("claude-code: matches the `claude` comm directly, never the `node` ancestor", () => {
    expect(selectAnchorPid(CLAUDE_CHAIN, "claude-code")).toBe(4900);
  });

  test("non-cursor without a harness comm token does NOT fall back to node", () => {
    // A bare `node` ancestor must not be mis-claimed as a CC/Codex anchor;
    // only cursor opts into the node fallback.
    expect(selectAnchorPid(CURSOR_POST_TOOL_USE_CHAIN, "claude-code")).toBeUndefined();
    expect(selectAnchorPid(CURSOR_POST_TOOL_USE_CHAIN, "codex")).toBeUndefined();
    expect(selectAnchorPid(CURSOR_POST_TOOL_USE_CHAIN, undefined)).toBeUndefined();
  });

  test("primary comm token wins over the node fallback even under cursor", () => {
    const withCursorComm = [
      { pid: 9, comm: "bash" },
      { pid: 8, comm: "node" },
      { pid: 7, comm: "cursor" },
    ];
    expect(selectAnchorPid(withCursorComm, "cursor")).toBe(7);
  });

  test("empty chain → undefined", () => {
    expect(selectAnchorPid([], "cursor")).toBeUndefined();
  });
});

describe("parsePsChainLine (macOS/BSD `ps -o ppid=,comm=` fallback)", () => {
  test("reduces a full executable path to its basename", () => {
    // Real macOS chain: the Claude Code native binary lives under the VS Code
    // extension dir; only the basename `claude` matches the comm token set.
    expect(
      parsePsChainLine(
        "83268 /Users/user/.vscode/extensions/anthropic.claude-code-2.1.191-darwin-arm64/resources/native-binary/claude",
      ),
    ).toEqual({ ppid: 83268, comm: "claude" });
  });

  test("handles right-aligned ppid padding from `ps`", () => {
    expect(parsePsChainLine("  62968 /bin/zsh")).toEqual({ ppid: 62968, comm: "zsh" });
  });

  test("keeps a basename that itself contains spaces (Apple helper)", () => {
    expect(
      parsePsChainLine(
        "55724 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
      ),
    ).toEqual({ ppid: 55724, comm: "Code Helper (Plugin)" });
  });

  test("a bare comm with no path is returned as-is", () => {
    expect(parsePsChainLine("4900 node")).toEqual({ ppid: 4900, comm: "node" });
  });

  test("returns null for a line with no leading numeric ppid", () => {
    expect(parsePsChainLine("")).toBeNull();
    expect(parsePsChainLine("   ")).toBeNull();
    expect(parsePsChainLine("not-a-pid claude")).toBeNull();
  });
});
