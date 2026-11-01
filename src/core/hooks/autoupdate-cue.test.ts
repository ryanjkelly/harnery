import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutoUpdateNotice } from "../autoupdate/types.ts";
import {
  AUTOUPDATE_CUE_PREFIX,
  type AutoUpdateCueDeps,
  autoUpdateHookContext,
} from "./autoupdate-cue.ts";

const roots: string[] = [];

function makeRoot(config?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-autoupdate-cue-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  if (config !== undefined) {
    writeFileSync(join(root, ".harnery", "config.jsonc"), JSON.stringify(config));
  }
  return root;
}

function notice(text: string, kind: AutoUpdateNotice["kind"] = "info"): AutoUpdateNotice {
  return { id: text, at: "2026-11-01T12:00:00.000Z", kind, text };
}

function fakeDeps(notices: AutoUpdateNotice[] = []) {
  const calls = { tick: [] as string[], notices: [] as Array<[string, string]> };
  const deps: AutoUpdateCueDeps = {
    tick: (root) => {
      calls.tick.push(root);
      return { action: "throttled" };
    },
    pendingNotices: (root, key) => {
      calls.notices.push([root, key]);
      return notices;
    },
  };
  return { deps, calls };
}

afterEach(() => {
  delete process.env.HARNERY_AUTOUPDATE_CHILD;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("autoUpdateHookContext", () => {
  test("a project without autoUpdate never ticks", async () => {
    const root = makeRoot({});
    const { deps, calls } = fakeDeps([notice("x")]);
    expect(await autoUpdateHookContext(root, "inst-1", { deps })).toBe("");
    expect(calls.tick).toEqual([]);
    expect(calls.notices).toEqual([]);
  });

  test("a configured project ticks and receives prefixed notices", async () => {
    const root = makeRoot({ autoUpdate: { enabled: true, steps: [["bin/pull"]] } });
    const { deps, calls } = fakeDeps([
      notice("Instructions changed; reread them.", "instructions"),
      notice("  Sign in again to the package registry.  ", "person"),
    ]);
    const cue = await autoUpdateHookContext(root, "inst-1", { deps });
    expect(calls.tick).toEqual([root]);
    expect(calls.notices).toEqual([[root, "inst-1"]]);
    expect(cue).toBe(
      `${AUTOUPDATE_CUE_PREFIX}Instructions changed; reread them.\n${AUTOUPDATE_CUE_PREFIX}Sign in again to the package registry.`,
    );
  });

  test("deliver false ticks but leaves notices queued", async () => {
    const root = makeRoot({ autoUpdate: { enabled: true } });
    const { deps, calls } = fakeDeps([notice("x")]);
    expect(await autoUpdateHookContext(root, "inst-1", { deps, deliver: false })).toBe("");
    expect(calls.tick).toEqual([root]);
    expect(calls.notices).toEqual([]);
  });

  test("the auto-update child process never re-triggers itself", async () => {
    const root = makeRoot({ autoUpdate: { enabled: true } });
    process.env.HARNERY_AUTOUPDATE_CHILD = "1";
    const { deps, calls } = fakeDeps([notice("x")]);
    expect(await autoUpdateHookContext(root, "inst-1", { deps })).toBe("");
    expect(calls.tick).toEqual([]);
  });

  test("fails open: a throwing tick still delivers, a throwing delivery returns empty", async () => {
    const root = makeRoot({ autoUpdate: { enabled: true } });
    const errors: string[] = [];
    const onError = (_err: unknown, phase: string) => errors.push(phase);
    const cue = await autoUpdateHookContext(root, "inst-1", {
      onError,
      deps: {
        tick: () => {
          throw new Error("stat failed");
        },
        pendingNotices: () => [notice("still here")],
      },
    });
    expect(cue).toBe(`${AUTOUPDATE_CUE_PREFIX}still here`);
    const empty = await autoUpdateHookContext(root, "inst-1", {
      onError,
      deps: {
        tick: () => ({ action: "throttled" }),
        pendingNotices: () => {
          throw new Error("state unreadable");
        },
      },
    });
    expect(empty).toBe("");
    expect(errors).toEqual(["autoupdate-tick", "autoupdate-notices"]);
  });
});
