import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  descriptorPathsAvailable,
  git,
  gitFixture,
  quiet,
  writeScript,
} from "../../../tests/workspace-test-helpers.ts";
import { stableDigest } from "../workflow/durable-record.ts";
import { runWorkflow } from "../workflow/engine.ts";
import { createLocalGitWorktreeProvider } from "../workflow/workspaces/local-git.ts";
import {
  readWorkspaceClaim,
  workspaceClaimPath,
  writeWorkspaceClaim,
} from "../workflow/workspaces/state.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const { host, repo } = gitFixture("turn-content");
  roots.push(host);
  writeFileSync(join(repo, "owned.txt"), "base\n");
  writeFileSync(join(repo, "peer.txt"), "peer base\n");
  const script = writeScript(repo, "export default async () => 'done';\n");
  git(repo, "add", "owned.txt", "peer.txt", "scripts");
  git(repo, "commit", "-qm", "fixture");
  const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
  const result = await runWorkflow(script, {
    coordRoot: repo,
    cwd: repo,
    spawners: {},
    isolation: "worktree",
    workspace: { provider, writableRoots: [host] },
    ...quiet,
  });
  const binding = result.workspaceBinding!;
  expect(binding).toBeDefined();
  return { host, coord: repo, root: binding.workspace_root, binding, script, provider };
}

describe.skipIf(!descriptorPathsAvailable)("turn content rollback", () => {
  test("syncs new pending capture directory names before content persistence completes", async () => {
    const api = await import("./index.ts");
    const ctx = await fixture();
    const synced: string[] = [];
    const original = fs.fsyncSync;
    const sync = spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
      synced.push(fs.realpathSync(`/proc/self/fd/${fd}`));
      original(fd);
    });
    try {
      await api.beginTurnRollback(ctx.coord, {
        binding: ctx.binding,
        turn: { turn_id: "durable-names", generation: 1 },
        paths: ["owned.txt"],
        onSnapshotStep() {
          const state = join(
            ctx.coord,
            ".harnery",
            "turn-rollback",
            ctx.binding.provider.id,
            ctx.binding.binding_id,
          );
          expect(synced).toContain(join(state, "captures"));
          expect(synced).toContain(state);
          expect(synced).toContain(join(ctx.coord, ".harnery", "turn-rollback"));
        },
      });
    } finally {
      sync.mockRestore();
    }
  });
  test("pending capture and pending seal block another turn after content persistence fails", async () => {
    const api = await import("./index.ts");
    for (const phase of ["before", "end"] as const) {
      const ctx = await fixture();
      let id = "";
      const fault = (_step: "content_persisted", captureId: string) => {
        id = captureId;
        throw new Error("interrupted snapshot metadata");
      };
      const begin = {
        binding: ctx.binding,
        turn: { turn_id: phase, generation: 1 },
        paths: ["owned.txt"],
      };
      if (phase === "before")
        await expect(
          api.beginTurnRollback(ctx.coord, { ...begin, onSnapshotStep: fault }),
        ).rejects.toThrow("interrupted");
      else {
        const capture = await api.beginTurnRollback(ctx.coord, begin);
        await expect(
          api.sealTurnRollback(ctx.coord, {
            binding: ctx.binding,
            capture_id: capture.capture_id,
            onSnapshotStep: fault,
          }),
        ).rejects.toThrow("interrupted");
      }
      expect(
        api.inspectTurnRollback(ctx.coord, { binding: ctx.binding, capture_id: id }).status,
      ).toBe("unknown");
      await expect(
        api.beginTurnRollback(ctx.coord, {
          binding: ctx.binding,
          turn: { turn_id: "later", generation: 2 },
          paths: ["owned.txt"],
        }),
      ).rejects.toThrow("unknown");
      expect(readFileSync(join(ctx.root, "owned.txt"), "utf8")).toBe("base\n");
    }
  });

  test("a damaged receipt never reports applied or authorizes another restore", async () => {
    const api = await import("./index.ts");
    const ctx = await fixture();
    const capture = await api.beginTurnRollback(ctx.coord, {
      binding: ctx.binding,
      turn: { turn_id: "receipt", generation: 1 },
      paths: ["owned.txt"],
    });
    writeFileSync(join(ctx.root, "owned.txt"), "end\n");
    await api.sealTurnRollback(ctx.coord, { binding: ctx.binding, capture_id: capture.capture_id });
    const plan = await api.prepareTurnRollback(ctx.coord, {
      binding: ctx.binding,
      capture_id: capture.capture_id,
    });
    const apply = {
      binding: ctx.binding,
      plan,
      yes: true,
      actor: "fixture",
      reason: "receipt verification",
    };
    expect((await api.applyTurnRollback(ctx.coord, apply)).status).toBe("applied");
    expect((await api.applyTurnRollback(ctx.coord, apply)).status).toBe("already_applied");
    const receipt = join(
      ctx.coord,
      ".harnery",
      "turn-rollback",
      ctx.binding.provider.id,
      ctx.binding.binding_id,
      "captures",
      capture.capture_id,
      "receipt.json",
    );
    for (const bad of [
      "{",
      JSON.stringify({
        schema_version: 1,
        status: "applied",
        capture_id: capture.capture_id,
        plan_sha256: "wrong",
      }),
    ]) {
      writeFileSync(receipt, bad);
      expect(() =>
        api.inspectTurnRollback(ctx.coord, {
          binding: ctx.binding,
          capture_id: capture.capture_id,
        }),
      ).toThrow();
      await expect(api.applyTurnRollback(ctx.coord, apply)).rejects.toThrow();
      await expect(
        api.beginTurnRollback(ctx.coord, {
          binding: ctx.binding,
          turn: { turn_id: "after-damaged-receipt", generation: 2 },
          paths: ["owned.txt"],
        }),
      ).rejects.toThrow();
      expect(readFileSync(join(ctx.root, "owned.txt"), "utf8")).toBe("base\n");
    }
  });

  test("enforces cumulative bytes and capture count using valid retained snapshot manifests", async () => {
    const api = await import("./index.ts");
    const ctx = await fixture();
    writeFileSync(join(ctx.root, "owned.txt"), Buffer.alloc(4 * 1024 * 1024, 65));
    git(ctx.root, "add", "owned.txt");
    const capture = await api.beginTurnRollback(ctx.coord, {
      binding: ctx.binding,
      turn: { turn_id: "retained", generation: 1 },
      paths: ["owned.txt"],
    });
    const sealed = await api.sealTurnRollback(ctx.coord, {
      binding: ctx.binding,
      capture_id: capture.capture_id,
    });
    const capturesRoot = join(
      ctx.coord,
      ".harnery",
      "turn-rollback",
      ctx.binding.provider.id,
      ctx.binding.binding_id,
      "captures",
    );
    const clone = (generation: number) => {
      const { sha256: _oldDigest, ...basis } = capture;
      const id = `turn-${generation.toString(16).padStart(32, "0")}`;
      const nextBasis = {
        ...basis,
        capture_id: id,
        turn: { turn_id: `retained-${generation}`, generation },
      };
      const next = { ...nextBasis, sha256: stableDigest(nextBasis) };
      mkdirSync(join(capturesRoot, id));
      writeFileSync(join(capturesRoot, id, "begin.json"), JSON.stringify(next));
      writeFileSync(
        join(capturesRoot, id, "end.json"),
        JSON.stringify({ capture_sha256: next.sha256, snapshot: sealed.end }),
      );
    };
    for (let generation = 2; generation <= 4; generation++) clone(generation);
    await expect(
      api.beginTurnRollback(ctx.coord, {
        binding: ctx.binding,
        turn: { turn_id: "byte-limit", generation: 5 },
        paths: ["owned.txt"],
      }),
    ).rejects.toThrow("retention byte limit");
    for (let generation = 5; generation <= 64; generation++) clone(generation);
    await expect(
      api.beginTurnRollback(ctx.coord, {
        binding: ctx.binding,
        turn: { turn_id: "count-limit", generation: 65 },
        paths: ["owned.txt"],
      }),
    ).rejects.toThrow("count limit");
  });
  test("refuses a real intent-to-add index entry without changing its flags", async () => {
    const api = await import("./index.ts");
    const ctx = await fixture();
    writeFileSync(join(ctx.root, "intent.txt"), "not staged\n");
    git(ctx.root, "add", "-N", "intent.txt");
    const before = git(ctx.root, "ls-files", "--debug", "intent.txt");
    await expect(
      api.beginTurnRollback(ctx.coord, {
        binding: ctx.binding,
        turn: { turn_id: "intent", generation: 1 },
        paths: ["intent.txt"],
      }),
    ).rejects.toThrow("intent-to-add");
    expect(git(ctx.root, "ls-files", "--debug", "intent.txt")).toBe(before);
  });
  test("an actual killed restore stays unknown and retry makes no further content writes", async () => {
    const api = await import("./index.ts");
    const ctx = await fixture();
    const capture = await api.beginTurnRollback(ctx.coord, {
      binding: ctx.binding,
      turn: { turn_id: "crash", generation: 1 },
      paths: ["owned.txt", "peer.txt"],
    });
    writeFileSync(join(ctx.root, "owned.txt"), "owned end\n");
    writeFileSync(join(ctx.root, "peer.txt"), "peer end\n");
    git(ctx.root, "add", "owned.txt", "peer.txt");
    await api.sealTurnRollback(ctx.coord, { binding: ctx.binding, capture_id: capture.capture_id });
    const plan = await api.prepareTurnRollback(ctx.coord, {
      binding: ctx.binding,
      capture_id: capture.capture_id,
    });
    const inputPath = join(ctx.host, "crash.json");
    const marker = join(ctx.host, "crash-boundary");
    writeFileSync(
      inputPath,
      JSON.stringify({ coord: ctx.coord, binding: ctx.binding, plan, marker }),
    );
    const killed = spawnSync(
      process.execPath,
      [join(import.meta.dir, "__fixtures__", "crash.ts"), inputPath],
      { timeout: 20_000 },
    );
    expect(killed.signal).toBe("SIGKILL");
    expect(readFileSync(marker, "utf8")).toBe("worktree_published");
    expect(
      api.inspectTurnRollback(ctx.coord, { binding: ctx.binding, capture_id: capture.capture_id })
        .status,
    ).toBe("unknown");
    const after = [
      readFileSync(join(ctx.root, "owned.txt")),
      readFileSync(join(ctx.root, "peer.txt")),
      git(ctx.root, "ls-files", "--stage"),
    ];
    expect(after[0]).toEqual(Buffer.from("base\n"));
    expect(after[1]).toEqual(Buffer.from("peer end\n"));
    await expect(
      api.applyTurnRollback(ctx.coord, {
        binding: ctx.binding,
        plan,
        yes: true,
        actor: "fixture",
        reason: "must refuse",
      }),
    ).rejects.toThrow("rollback outcome is unknown; automatic retry is refused");
    expect([
      readFileSync(join(ctx.root, "owned.txt")),
      readFileSync(join(ctx.root, "peer.txt")),
      git(ctx.root, "ls-files", "--stage"),
    ]).toEqual(after);
  });

  test("retained physical peer overlap refuses restore and reservation fences new publication", async () => {
    const api = await import("./index.ts");
    const ctx = await fixture();
    const capture = await api.beginTurnRollback(ctx.coord, {
      binding: ctx.binding,
      turn: { turn_id: "peer", generation: 1 },
      paths: ["owned.txt"],
    });
    writeFileSync(join(ctx.root, "owned.txt"), "end\n");
    await api.sealTurnRollback(ctx.coord, { binding: ctx.binding, capture_id: capture.capture_id });
    const plan = await api.prepareTurnRollback(ctx.coord, {
      binding: ctx.binding,
      capture_id: capture.capture_id,
    });
    const peer = (
      await runWorkflow(ctx.script, {
        coordRoot: ctx.coord,
        cwd: ctx.coord,
        spawners: {},
        isolation: "worktree",
        workspace: { provider: ctx.provider, writableRoots: [ctx.host] },
        ...quiet,
      })
    ).workspaceBinding!;
    const claim = readWorkspaceClaim(ctx.coord, peer.provider.id, peer.binding_id)!;
    renameSync(peer.workspace_root, `${peer.workspace_root}-retained`);
    symlinkSync(ctx.root, peer.workspace_root, "dir");
    await expect(
      api.applyTurnRollback(ctx.coord, {
        binding: ctx.binding,
        plan,
        yes: true,
        actor: "fixture",
        reason: "must refuse",
      }),
    ).rejects.toThrow("peer");
    expect(readFileSync(join(ctx.root, "owned.txt"), "utf8")).toBe("end\n");
    const claimPath = workspaceClaimPath(ctx.coord, peer.provider.id, peer.binding_id);
    renameSync(claimPath, join(ctx.host, "withheld-claim.json"));
    // Keep the retained peer directory out of the supported provider inventory.
    renameSync(
      join(ctx.coord, ".harnery", "workspaces", peer.provider.id, peer.binding_id),
      join(ctx.host, "withheld-peer"),
    );
    let refusal = "";
    const result = await api.applyTurnRollback(ctx.coord, {
      binding: ctx.binding,
      plan,
      yes: true,
      actor: "fixture",
      reason: "reservation publication proof",
      onStep(step) {
        if (step !== "started") return;
        try {
          writeWorkspaceClaim(ctx.coord, claim);
        } catch (error) {
          refusal = String(error);
        }
        // A refused publish creates no claim, but its directory remains an invalid inventory
        // entry. Remove only that empty fixture directory before the next authority check.
        rmSync(join(ctx.coord, ".harnery", "workspaces", peer.provider.id, peer.binding_id), {
          recursive: true,
          force: true,
        });
      },
    });
    expect(refusal).toContain("workspace-reclaim");
    expect(existsSync(claimPath)).toBe(false);
    expect(result.status).toBe("applied");
    expect(readFileSync(join(ctx.root, "owned.txt"), "utf8")).toBe("base\n");
  });
  test("restores staged, unstaged and explicit untracked bytes without consuming peer edits", async () => {
    // Keep the missing-capability assertion executable before the API exists.
    expect(existsSync(join(import.meta.dir, "index.ts"))).toBe(true);
    const api = await import("./index.ts");
    const ctx = await fixture();
    writeFileSync(join(ctx.root, "owned.txt"), "staged A\n");
    git(ctx.root, "add", "owned.txt");
    writeFileSync(join(ctx.root, "owned.txt"), "unstaged B\n");
    writeFileSync(join(ctx.root, "untracked.txt"), "untracked C\n");
    const indexPath = git(ctx.root, "rev-parse", "--git-path", "index");
    const indexBefore = readFileSync(indexPath);
    const capture = await api.beginTurnRollback(ctx.coord, {
      binding: ctx.binding,
      turn: { turn_id: "turn-one", generation: 1 },
      paths: ["owned.txt", "untracked.txt", "new.txt"],
    });
    expect(readFileSync(indexPath)).toEqual(indexBefore);
    writeFileSync(join(ctx.root, "owned.txt"), "staged end\n");
    git(ctx.root, "add", "owned.txt");
    writeFileSync(join(ctx.root, "owned.txt"), "unstaged end\n");
    writeFileSync(join(ctx.root, "untracked.txt"), "changed untracked\n");
    writeFileSync(join(ctx.root, "new.txt"), "new in turn\n");
    await api.sealTurnRollback(ctx.coord, { binding: ctx.binding, capture_id: capture.capture_id });
    const plan = await api.prepareTurnRollback(ctx.coord, {
      binding: ctx.binding,
      capture_id: capture.capture_id,
    });
    writeFileSync(join(ctx.root, "peer.txt"), "independent peer\n");
    git(ctx.root, "add", "peer.txt");
    expect((await api.applyTurnRollback(ctx.coord, { binding: ctx.binding, plan })).status).toBe(
      "preview",
    );
    expect(readFileSync(join(ctx.root, "owned.txt"), "utf8")).toBe("unstaged end\n");
    expect(
      (
        await api.applyTurnRollback(ctx.coord, {
          binding: ctx.binding,
          plan,
          yes: true,
          actor: "fixture",
          reason: "undo exact turn",
        })
      ).status,
    ).toBe("applied");
    expect(git(ctx.root, "show", ":owned.txt")).toBe("staged A");
    expect(readFileSync(join(ctx.root, "owned.txt"), "utf8")).toBe("unstaged B\n");
    expect(readFileSync(join(ctx.root, "untracked.txt"), "utf8")).toBe("untracked C\n");
    expect(existsSync(join(ctx.root, "new.txt"))).toBe(false);
    expect(git(ctx.root, "ls-files", "--", "untracked.txt")).toBe("");
    expect(git(ctx.root, "show", ":peer.txt")).toBe("independent peer");
    expect(readFileSync(join(ctx.root, "peer.txt"), "utf8")).toBe("independent peer\n");
  });

  test("refuses administrative paths, aliases, nested repositories and unsafe scope without writes", async () => {
    const api = await import("./index.ts");
    const ctx = await fixture();
    const control = readFileSync(join(ctx.root, ".git"));
    mkdirSync(join(ctx.root, ".harnery"));
    writeFileSync(join(ctx.root, ".harnery", "control.txt"), "authority bytes\n");
    git(ctx.root, "add", "--force", ".harnery/control.txt");
    mkdirSync(join(ctx.root, "nested"));
    git(join(ctx.root, "nested"), "init", "-q");
    writeFileSync(join(ctx.root, "nested", "file"), "nested bytes");
    symlinkSync(join(ctx.root, "peer.txt"), join(ctx.root, "alias.txt"));
    for (const path of [
      ".harnery/control.txt",
      ".git",
      ".harnery/state",
      "../outside",
      "nested/file",
      "alias.txt",
      "owned.txt/child",
    ]) {
      await expect(
        api.beginTurnRollback(ctx.coord, {
          binding: ctx.binding,
          turn: { turn_id: "unsafe", generation: 1 },
          paths: [path],
        }),
      ).rejects.toThrow();
    }
    expect(readFileSync(join(ctx.root, ".git"))).toEqual(control);
    expect(readFileSync(join(ctx.root, "peer.txt"), "utf8")).toBe("peer base\n");
  });

  test("rejects a stale selected path and a tampered plan before restoring any bytes", async () => {
    const api = await import("./index.ts");
    const ctx = await fixture();
    const capture = await api.beginTurnRollback(ctx.coord, {
      binding: ctx.binding,
      turn: { turn_id: "stale", generation: 1 },
      paths: ["owned.txt"],
    });
    writeFileSync(join(ctx.root, "owned.txt"), "end\n");
    await api.sealTurnRollback(ctx.coord, { binding: ctx.binding, capture_id: capture.capture_id });
    const plan = await api.prepareTurnRollback(ctx.coord, {
      binding: ctx.binding,
      capture_id: capture.capture_id,
    });
    const apply = { binding: ctx.binding, plan, yes: true, actor: "fixture", reason: "undo turn" };
    await expect(
      api.applyTurnRollback(ctx.coord, { ...apply, plan: { ...plan, capture_id: "other" } }),
    ).rejects.toThrow();
    writeFileSync(join(ctx.root, "owned.txt"), "newer edit\n");
    await expect(api.applyTurnRollback(ctx.coord, apply)).rejects.toThrow("changed");
    expect(readFileSync(join(ctx.root, "owned.txt"), "utf8")).toBe("newer edit\n");
    expect(
      api.inspectTurnRollback(ctx.coord, { binding: ctx.binding, capture_id: capture.capture_id })
        .status,
    ).toBe("sealed");
    writeFileSync(join(ctx.root, "owned.txt"), "end\n");
    const events = join(
      ctx.coord,
      ".harnery",
      "workspaces",
      ctx.binding.provider.id,
      ctx.binding.binding_id,
      "events.jsonl",
    );
    chmodSync(events, 0o400);
    try {
      await expect(api.applyTurnRollback(ctx.coord, apply)).rejects.toThrow();
    } finally {
      chmodSync(events, 0o600);
    }
    expect(readFileSync(join(ctx.root, "owned.txt"), "utf8")).toBe("end\n");
    expect(
      api.inspectTurnRollback(ctx.coord, { binding: ctx.binding, capture_id: capture.capture_id })
        .status,
    ).toBe("sealed");
    git(ctx.root, "commit", "--allow-empty", "-qm", "HEAD drift");
    await expect(api.applyTurnRollback(ctx.coord, apply)).rejects.toThrow("HEAD changed");
    expect(readFileSync(join(ctx.root, "owned.txt"), "utf8")).toBe("end\n");
    git(ctx.root, "reset", "--soft", "HEAD^");
    const blob = capture.before.entries[0]!.worktree!.oid;
    const object = join(
      ctx.coord,
      ".harnery",
      "turn-rollback",
      ctx.binding.provider.id,
      ctx.binding.binding_id,
      "content.git",
      "objects",
      blob.slice(0, 2),
      blob.slice(2),
    );
    chmodSync(object, 0o600);
    writeFileSync(
      object,
      deflateSync(Buffer.concat([Buffer.from("blob 5\0"), Buffer.from("evil\n")])),
    );
    await expect(api.applyTurnRollback(ctx.coord, apply)).rejects.toThrow("blob digest changed");
    expect(readFileSync(join(ctx.root, "owned.txt"), "utf8")).toBe("end\n");
  });

  test("restores binary content and executable mode and retains unrelated index flags", async () => {
    const api = await import("./index.ts");
    const ctx = await fixture();
    const bytes = Buffer.from([0, 255, 13, 10, 128]);
    writeFileSync(join(ctx.root, "owned.txt"), bytes);
    chmodSync(join(ctx.root, "owned.txt"), 0o755);
    git(ctx.root, "add", "owned.txt");
    git(ctx.root, "update-index", "--assume-unchanged", "peer.txt");
    const capture = await api.beginTurnRollback(ctx.coord, {
      binding: ctx.binding,
      turn: { turn_id: "binary", generation: 1 },
      paths: ["owned.txt"],
    });
    writeFileSync(join(ctx.root, "owned.txt"), "end");
    chmodSync(join(ctx.root, "owned.txt"), 0o644);
    git(ctx.root, "add", "owned.txt");
    await api.sealTurnRollback(ctx.coord, { binding: ctx.binding, capture_id: capture.capture_id });
    const plan = await api.prepareTurnRollback(ctx.coord, {
      binding: ctx.binding,
      capture_id: capture.capture_id,
    });
    expect(
      (
        await api.applyTurnRollback(ctx.coord, {
          binding: ctx.binding,
          plan,
          yes: true,
          actor: "fixture",
          reason: "restore binary",
        })
      ).status,
    ).toBe("applied");
    expect(readFileSync(join(ctx.root, "owned.txt"))).toEqual(bytes);
    expect(git(ctx.root, "ls-files", "--stage", "owned.txt")).toStartWith("100755 ");
    expect(git(ctx.root, "ls-files", "-v", "peer.txt")).toStartWith("h ");
  });

  test("refuses a live or unknown workflow and a superseded turn", async () => {
    const api = await import("./index.ts");
    const ctx = await fixture();
    const capture = await api.beginTurnRollback(ctx.coord, {
      binding: ctx.binding,
      turn: { turn_id: "first", generation: 1 },
      paths: ["owned.txt"],
    });
    writeFileSync(join(ctx.root, "owned.txt"), "end");
    await api.sealTurnRollback(ctx.coord, { binding: ctx.binding, capture_id: capture.capture_id });
    const plan = await api.prepareTurnRollback(ctx.coord, {
      binding: ctx.binding,
      capture_id: capture.capture_id,
    });
    const transcript = join(
      ctx.coord,
      ".harnery",
      "workflows",
      ctx.binding.run_id,
      "transcript.jsonl",
    );
    const prior = readFileSync(transcript, "utf8");
    for (const tail of [
      JSON.stringify({ event: "run.resume", run_id: ctx.binding.run_id }),
      "invalid json",
    ]) {
      writeFileSync(transcript, `${prior}${tail}\n`);
      await expect(
        api.applyTurnRollback(ctx.coord, {
          binding: ctx.binding,
          plan,
          yes: true,
          actor: "fixture",
          reason: "must refuse",
        }),
      ).rejects.toThrow();
      expect(readFileSync(join(ctx.root, "owned.txt"), "utf8")).toBe("end");
    }
    writeFileSync(transcript, prior);
    await api.beginTurnRollback(ctx.coord, {
      binding: ctx.binding,
      turn: { turn_id: "second", generation: 2 },
      paths: ["owned.txt"],
    });
    await expect(
      api.applyTurnRollback(ctx.coord, {
        binding: ctx.binding,
        plan,
        yes: true,
        actor: "fixture",
        reason: "must refuse",
      }),
    ).rejects.toThrow("latest");
  });

  test("refuses ignored files, selected index flags and a snapshot over the byte cap", async () => {
    const api = await import("./index.ts");
    const ctx = await fixture();
    git(ctx.root, "update-index", "--skip-worktree", "owned.txt");
    await expect(
      api.beginTurnRollback(ctx.coord, {
        binding: ctx.binding,
        turn: { turn_id: "flag", generation: 1 },
        paths: ["owned.txt"],
      }),
    ).rejects.toThrow();
    git(ctx.root, "update-index", "--no-skip-worktree", "owned.txt");
    writeFileSync(join(ctx.root, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(ctx.root, "ignored.txt"), "excluded\n");
    await expect(
      api.beginTurnRollback(ctx.coord, {
        binding: ctx.binding,
        turn: { turn_id: "ignored", generation: 1 },
        paths: ["ignored.txt"],
      }),
    ).rejects.toThrow();
    writeFileSync(join(ctx.root, "huge.bin"), Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(
      api.beginTurnRollback(ctx.coord, {
        binding: ctx.binding,
        turn: { turn_id: "huge", generation: 1 },
        paths: ["huge.bin"],
      }),
    ).rejects.toThrow("limit");
  });
});
