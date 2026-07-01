import { describe, expect, test } from "bun:test";
import { canonicalize } from "./guard-path.ts";

// canonicalize decides which write-tool targets enter the claim guard. The key
// regression: out-of-repo paths (a /tmp scratchpad, session-temp files) must NOT
// be claimed. If they were, the ordering rule (which compares raw path strings)
// would sort an absolute "/tmp/…" before every repo-relative path ("/" = 0x2F <
// any letter) and spuriously block a legitimately-held repo file.
describe("canonicalize (claim-guard path)", () => {
  const root = "/home/user/projects/repo";

  test("strips coordRoot prefix → monorepo-relative", () => {
    expect(canonicalize(root, `${root}/bp-openclaw/docs/gotchas.md`)).toBe(
      "bp-openclaw/docs/gotchas.md",
    );
  });

  test("coordRoot itself → '.'", () => {
    expect(canonicalize(root, root)).toBe(".");
  });

  test("out-of-repo absolute path (scratchpad) → null (not claimed)", () => {
    expect(canonicalize(root, "/tmp/claude-1000/abc/scratchpad/fix-agents.py")).toBeNull();
    expect(canonicalize(root, "/var/folders/xy/T/session/notes.md")).toBeNull();
  });

  test("a sibling repo dir that merely shares a prefix is still out-of-repo", () => {
    // "/home/user/projects/repo-other/..." must not be mistaken for in-repo:
    // the in-repo check requires the "<root>/" separator, not a bare prefix match.
    expect(canonicalize(root, "/home/user/projects/repo-other/x.ts")).toBeNull();
  });

  test("relative path is treated as already-repo-relative (Codex apply_patch)", () => {
    expect(canonicalize(root, "src/index.ts")).toBe("src/index.ts");
  });

  test("empty → null", () => {
    expect(canonicalize(root, "")).toBeNull();
  });

  test("regression: out-of-repo path can never sort-block a held repo file", () => {
    // This is the whole point: the scratchpad path is dropped before it ever
    // reaches the ordering comparison against a held repo-relative claim.
    const held = "bp-openclaw/docs/gotchas.md";
    const scratch = canonicalize(root, "/tmp/x/scratchpad/fix.py");
    expect(scratch).toBeNull();
    // Sanity-check the hazard the null guards against: had it passed through raw,
    // the string compare would have ranked it before the held repo file.
    expect("/tmp/x/scratchpad/fix.py" < held).toBe(true);
  });
});
