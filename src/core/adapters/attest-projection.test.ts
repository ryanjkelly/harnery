import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnRequest, SpawnResult } from "../workflow/types.ts";
import { probeFilesystemProjection } from "./attest-projection.ts";
import type { Adapter, AdapterSandboxProjection } from "./types.ts";

const PROJECTION: AdapterSandboxProjection = {
  modes: { "read-only": "read-only", "workspace-write": "workspace-write" },
  writableRoots: true,
};

function adapterWith(projection: AdapterSandboxProjection | undefined): Adapter {
  return { profile: { sandboxProjection: projection } } as unknown as Adapter;
}

const ok = (): SpawnResult => ({ ok: true, text: "done", durationMs: 1 }) as SpawnResult;
const failed = (error: string): SpawnResult =>
  ({ ok: false, text: "", error, durationMs: 1 }) as SpawnResult;

/**
 * A fake child that writes its sentinel only when the mode permits it, which is
 * what a correctly-sandboxed vendor CLI does. `enforces: false` models the
 * failure this probe exists to catch: the flag is accepted and ignored.
 */
function fakeChild(opts: { enforces: boolean; writes?: boolean; turnFails?: boolean }) {
  const seen: Array<{ mode: string; cwd: string }> = [];
  const spawn = async (request: SpawnRequest): Promise<SpawnResult> => {
    const mode = request.filesystemPolicy?.mode ?? "none";
    seen.push({ mode, cwd: request.cwd ?? "" });
    const permitted = mode !== "read-only" || !opts.enforces;
    const sentinel = /named (\S+) /.exec(request.prompt)?.[1];
    if ((opts.writes ?? true) && permitted && sentinel) {
      writeFileSync(join(request.cwd ?? "", sentinel), "ok");
    }
    if (opts.turnFails && mode === "read-only") return failed("sandbox denied the write");
    return ok();
  };
  return { spawn, seen };
}

/** Must await before cleanup: a sync `finally` around an async callback deletes
 * the directory while the probe is still using it. */
async function withWorkdir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "harnery-projection-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const base = { timeoutMs: 1_000, subscriptionOnly: true };

describe("probeFilesystemProjection", () => {
  test("an enforced read-only sandbox reads as supported", async () => {
    await withWorkdir(async (workdir) => {
      const child = fakeChild({ enforces: true });
      const result = await probeFilesystemProjection(adapterWith(PROJECTION), {
        ...base,
        workdir,
        spawn: child.spawn,
      });
      expect(result.observation).toBe("supported");
      expect(child.seen.map((s) => s.mode)).toEqual(["workspace-write", "read-only"]);
    });
  });

  test("a sandbox that accepts the flag but does not enforce it reads as unsupported", async () => {
    await withWorkdir(async (workdir) => {
      const child = fakeChild({ enforces: false });
      const result = await probeFilesystemProjection(adapterWith(PROJECTION), {
        ...base,
        workdir,
        spawn: child.spawn,
      });
      expect(result.observation).toBe("unsupported");
      expect(result.detail).toContain("not enforced");
    });
  });

  test("a control child that never writes makes the probe inconclusive, not supported", async () => {
    // The confound this whole design exists for. Without the control, a child
    // that simply ignored the instruction would look exactly like enforcement.
    await withWorkdir(async (workdir) => {
      const child = fakeChild({ enforces: true, writes: false });
      const result = await probeFilesystemProjection(adapterWith(PROJECTION), {
        ...base,
        workdir,
        spawn: child.spawn,
      });
      expect(result.observation).toBe("inconclusive");
      // And it stopped after the control: no point spending the treatment turn.
      expect(child.seen).toHaveLength(1);
    });
  });

  test("a failed treatment turn is still evidence when the file is absent", async () => {
    // A read-only child refusing the write may well end its turn unhappily.
    // Refusing IS the observation, so only the filesystem decides.
    await withWorkdir(async (workdir) => {
      const child = fakeChild({ enforces: true, turnFails: true });
      const result = await probeFilesystemProjection(adapterWith(PROJECTION), {
        ...base,
        workdir,
        spawn: child.spawn,
      });
      expect(result.observation).toBe("supported");
      expect(result.detail).toContain("sandbox denied the write");
    });
  });

  test("a failed control turn is inconclusive", async () => {
    await withWorkdir(async (workdir) => {
      const result = await probeFilesystemProjection(adapterWith(PROJECTION), {
        ...base,
        workdir,
        spawn: async () => failed("vendor unreachable"),
      });
      expect(result.observation).toBe("inconclusive");
      expect(result.detail).toContain("vendor unreachable");
    });
  });

  test("a throwing spawn is inconclusive rather than an exception", async () => {
    await withWorkdir(async (workdir) => {
      const result = await probeFilesystemProjection(adapterWith(PROJECTION), {
        ...base,
        workdir,
        spawn: async () => {
          throw new Error("spawn exploded");
        },
      });
      expect(result.observation).toBe("inconclusive");
      expect(result.detail).toContain("spawn exploded");
    });
  });

  test("an adapter with no declared projection spends no vendor turn at all", async () => {
    let calls = 0;
    const result = await probeFilesystemProjection(adapterWith(undefined), {
      ...base,
      spawn: async () => {
        calls += 1;
        return ok();
      },
    });
    expect(result.observation).toBe("inconclusive");
    expect(calls).toBe(0);
  });
});
