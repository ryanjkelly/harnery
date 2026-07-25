import { describe, expect, test } from "bun:test";
import type { HarnessSandboxProjection } from "../harnesses/types.ts";
import { resolveSandboxProjection, SandboxProjectionError } from "./sandbox-projection.ts";
import { buildClaudeInvocation } from "./spawn-claude.ts";
import { buildCodexInvocation } from "./spawn-codex.ts";
import { buildCursorInvocation } from "./spawn-cursor.ts";
import type { SpawnRequest } from "./types.ts";

const CAPABLE: HarnessSandboxProjection = {
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
    const partial: HarnessSandboxProjection = {
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

  test("writable roots are refused when the harness cannot carry them", () => {
    const noRoots: HarnessSandboxProjection = { ...CAPABLE, writableRoots: false };
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

  test("a harness without writable-root support still accepts a bare mode", () => {
    const noRoots: HarnessSandboxProjection = { ...CAPABLE, writableRoots: false };
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
