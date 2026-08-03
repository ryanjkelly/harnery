import { describe, expect, test } from "bun:test";
import type { AdapterSandboxProjection } from "../adapters/types.ts";
import {
  assertProjectionWithinWorkspace,
  resolveGitGrantRoots,
  resolveSandboxProjection,
  SandboxProjectionError,
} from "./sandbox-projection.ts";
import { buildClaudeInvocation } from "./spawn-claude.ts";
import { buildCodexInvocation } from "./spawn-codex.ts";
import { buildCursorInvocation } from "./spawn-cursor.ts";
import type { SpawnRequest } from "./types.ts";

const CAPABLE: AdapterSandboxProjection = {
  modes: { "read-only": "read-only", "workspace-write": "workspace-write" },
  writableRoots: true,
};

const base: SpawnRequest = { prompt: "p", timeoutMs: 1_000, maxTurns: 1, cwd: "/work" };
const projected = (over: Partial<SpawnRequest> = {}): SpawnRequest => ({
  ...base,
  filesystemPolicy: { mode: "workspace-write", writableRoots: ["/work/.git"] },
  ...over,
});

describe("resolveSandboxProjection", () => {
  test("resolves a representable request", () => {
    const resolved = resolveSandboxProjection("codex", CAPABLE, {
      mode: "workspace-write",
      writableRoots: ["/work/.git"],
    });
    expect(resolved).toEqual({ nativeMode: "workspace-write", writableRoots: ["/work/.git"] });
  });

  test("an adapter with no declaration refuses", () => {
    expect(() => resolveSandboxProjection("claude-code", undefined, { mode: "read-only" })).toThrow(
      SandboxProjectionError,
    );
  });

  test("an undistinguished mode refuses rather than downgrading", () => {
    const partial: AdapterSandboxProjection = {
      modes: { "read-only": "read-only", "workspace-write": null },
      writableRoots: true,
    };
    let caught: SandboxProjectionError | undefined;
    try {
      resolveSandboxProjection("partial", partial, { mode: "workspace-write" });
    } catch (error) {
      caught = error as SandboxProjectionError;
    }
    expect(caught?.reason).toBe("mode_unrepresentable");
    // The whole point: no fallback to the other mode, and no vendor default.
    expect(caught?.message).toContain("cannot be enforced");
  });

  test("writable roots are refused when the adapter cannot carry them", () => {
    const noRoots: AdapterSandboxProjection = { ...CAPABLE, writableRoots: false };
    let caught: SandboxProjectionError | undefined;
    try {
      resolveSandboxProjection("no-roots", noRoots, {
        mode: "workspace-write",
        writableRoots: ["/work/.git"],
      });
    } catch (error) {
      caught = error as SandboxProjectionError;
    }
    expect(caught?.reason).toBe("writable_roots_unrepresentable");
  });

  test("a adapter without writable-root support still accepts a bare mode", () => {
    const noRoots: AdapterSandboxProjection = { ...CAPABLE, writableRoots: false };
    expect(resolveSandboxProjection("no-roots", noRoots, { mode: "read-only" }).nativeMode).toBe(
      "read-only",
    );
  });

  test("a non-string writable root is refused, not dereferenced", () => {
    // Found by an end-to-end run: an undefined entry reached the guard and
    // produced "root.startsWith is not a function" instead of a clear refusal.
    expect(() =>
      resolveSandboxProjection("codex", CAPABLE, {
        mode: "workspace-write",
        writableRoots: [undefined as unknown as string],
      }),
    ).toThrow(/absolute path/);
  });

  test("a relative writable root is refused", () => {
    expect(() =>
      resolveSandboxProjection("codex", CAPABLE, {
        mode: "workspace-write",
        writableRoots: ["relative/.git"],
      }),
    ).toThrow(/absolute path/);
  });
});

describe("adapter projection rendering (ADR 0039)", () => {
  test("no policy leaves the codex invocation exactly as it was", () => {
    const argv = buildCodexInvocation(base, "/work/out.txt").argv;
    expect(argv).toContain("--sandbox");
    expect(argv[argv.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(argv.join(" ")).not.toContain("writable_roots");
  });

  test("codex renders the mode and the writable-root set", () => {
    const argv = buildCodexInvocation(projected(), "/work/out.txt").argv;
    expect(argv[argv.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(argv).toContain('sandbox_workspace_write.writable_roots=["/work/.git"]');
  });

  test("codex renders read-only without a writable-root entry", () => {
    const argv = buildCodexInvocation(
      projected({ filesystemPolicy: { mode: "read-only" } }),
      "/work/out.txt",
    ).argv;
    expect(argv[argv.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(argv.join(" ")).not.toContain("writable_roots");
  });

  test("claude-code refuses a projection it cannot represent", () => {
    expect(() => buildClaudeInvocation(projected())).toThrow(SandboxProjectionError);
  });

  test("cursor refuses a projection it cannot represent", () => {
    expect(() => buildCursorInvocation(projected())).toThrow(SandboxProjectionError);
  });

  test("claude and cursor are unchanged when no policy is supplied", () => {
    expect(() => buildClaudeInvocation(base)).not.toThrow();
    expect(() => buildCursorInvocation(base)).not.toThrow();
  });
});

describe("assertProjectionWithinWorkspace", () => {
  const root = "/srv/ws";

  test("a path inside the validated root is allowed", () => {
    expect(() =>
      assertProjectionWithinWorkspace("codex", root, ["/srv/ws/repo/.git"]),
    ).not.toThrow();
  });

  test("the root itself is allowed", () => {
    expect(() => assertProjectionWithinWorkspace("codex", root, [root])).not.toThrow();
  });

  test("a trailing slash on the validated root does not change the answer", () => {
    expect(() => assertProjectionWithinWorkspace("codex", "/srv/ws/", [root])).not.toThrow();
  });

  test("a path outside the validated root is refused", () => {
    let caught: SandboxProjectionError | undefined;
    try {
      assertProjectionWithinWorkspace("codex", root, ["/etc"]);
    } catch (error) {
      caught = error as SandboxProjectionError;
    }
    expect(caught?.reason).toBe("writable_root_escapes_workspace");
  });

  test("a sibling with a shared prefix is refused, not treated as inside", () => {
    // The trap: naive startsWith would accept /srv/wsX as inside /srv/ws.
    expect(() => assertProjectionWithinWorkspace("codex", root, ["/srv/wsX/.git"])).toThrow(
      /outside the workspace root/,
    );
  });

  test("one bad path in a set refuses the whole set", () => {
    expect(() =>
      assertProjectionWithinWorkspace("codex", root, ["/srv/ws/ok", "/srv/elsewhere"]),
    ).toThrow(SandboxProjectionError);
  });

  test("an empty set is trivially contained", () => {
    expect(() => assertProjectionWithinWorkspace("codex", root, [])).not.toThrow();
  });

  test("the Git administrative directory of a linked worktree is NOT contained", () => {
    // Measured, not assumed: for a linked worktree both halves live under the
    // source repository, so neither is inside the workspace root. This is the
    // whole reason the grant exists as a named capability (ADR 0040) instead of
    // a path a caller can pass through `writableRoots`.
    expect(() =>
      assertProjectionWithinWorkspace("codex", "/srv/ws/wt", ["/home/u/src/.git/worktrees/wt"]),
    ).toThrow(/outside the workspace root/);
    expect(() =>
      assertProjectionWithinWorkspace("codex", "/srv/ws/wt", ["/home/u/src/.git"]),
    ).toThrow(/outside the workspace root/);
  });
});

describe("resolveGitGrantRoots", () => {
  const binding = (gitdir: string, commonDir: string) =>
    ({
      repository: {
        gitdir: { realpath: gitdir },
        common_dir: { realpath: commonDir },
      },
    }) as unknown as Parameters<typeof resolveGitGrantRoots>[1];

  test('"none" grants nothing and needs no binding', () => {
    expect(resolveGitGrantRoots("none", undefined)).toEqual([]);
  });

  test("a linked worktree grants both halves, because a commit needs the shared one", () => {
    expect(
      resolveGitGrantRoots(
        "shared-repository",
        binding("/home/u/src/.git/worktrees/wt", "/home/u/src/.git"),
      ),
    ).toEqual(["/home/u/src/.git/worktrees/wt", "/home/u/src/.git"]);
  });

  test("a topology where both halves coincide grants one path, not a duplicate", () => {
    expect(
      resolveGitGrantRoots("shared-repository", binding("/srv/ws/repo/.git", "/srv/ws/repo/.git")),
    ).toEqual(["/srv/ws/repo/.git"]);
  });

  test("the grant refuses when the run has no workspace at all", () => {
    let caught: SandboxProjectionError | undefined;
    try {
      resolveGitGrantRoots("shared-repository", undefined);
    } catch (error) {
      caught = error as SandboxProjectionError;
    }
    expect(caught?.reason).toBe("git_grant_unavailable");
    expect(caught?.message).toContain("no isolated workspace");
  });

  test("the grant refuses when the workspace carries no repository", () => {
    const noRepo = {} as unknown as Parameters<typeof resolveGitGrantRoots>[1];
    expect(() => resolveGitGrantRoots("shared-repository", noRepo)).toThrow(
      /workspace with no repository/,
    );
  });
});
