import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  descriptorPathsAvailable,
  git,
  gitFixture,
  quiet,
  tempRoot,
  writeScript,
} from "../../../../tests/workspace-test-helpers.ts";
import {
  createWorkItem,
  readWorkItem,
  reconcileWorkItem,
  reopenWorkItem,
  runWorkItem,
} from "../../work/index.ts";
import { runWorkflow } from "../engine.ts";
import type { SpawnResult } from "../types.ts";
import { cleanupWorkspace } from "./cleanup.ts";
import { acquireNoClobberLease } from "./leases.ts";
import { createLocalGitWorktreeProvider } from "./local-git.ts";
import { readWorkflowLiveness } from "./recovery.ts";
import {
  readCleanupAttempts,
  readWorkspaceClaim,
  readWorkspaceEvents,
  stableDigest,
  writeWorkspaceClaim,
} from "./state.ts";
import type { WorkspaceProvider } from "./types.ts";

const roots: string[] = [];
const DIGEST = "a".repeat(64);
const DEAD_PID = 2_000_000_000;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function handshake<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function workspace() {
  const { host, repo } = gitFixture("workspace-conformance");
  roots.push(host);
  const script = writeScript(repo, "export default async () => 'done';\n");
  git(repo, "add", "scripts");
  git(repo, "commit", "-qm", "workflow");
  const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
  const report = await runWorkflow(script, {
    coordRoot: repo,
    cwd: repo,
    spawners: {},
    isolation: "worktree",
    workspace: { provider, writableRoots: [host] },
    ...quiet,
  });
  return { host, repo, provider, report, binding: report.workspaceBinding! };
}

describe.skipIf(!descriptorPathsAvailable)("exclusive workspace reclaim conformance", () => {
  for (const overlap of ["nested", "ancestor", "symlink", "archived", "after-preview"] as const) {
    test(`${overlap} peer ownership refuses discard before changing any file`, async () => {
      const { host, repo, provider, binding } = await workspace();
      const dirtyPath = join(binding.workspace_root, "README.md");
      writeFileSync(dirtyPath, "owned uncommitted work\n");
      if (overlap === "after-preview") {
        expect((await provider.reclaim(binding, { mode: "discard" })).ownership).toBe("ok");
      }

      // Retained claims remain recovery authority after a peer's run is archived.
      // The fixture records that authority without requiring the peer to be live.
      const own = readWorkspaceClaim(repo, binding.provider.id, binding.binding_id)!;
      let peerRoot = join(binding.workspace_root, "peer");
      if (overlap === "ancestor") peerRoot = dirname(binding.workspace_root);
      if (overlap === "symlink") {
        peerRoot = join(host, "peer-alias");
        symlinkSync(binding.workspace_root, peerRoot, "dir");
      } else {
        mkdirSync(peerRoot, { recursive: true });
      }
      const peerFile = join(peerRoot, "peer.txt");
      writeFileSync(peerFile, "peer recovery work\n");
      const request = { ...own.request, run_id: `wf-peer-${overlap}` };
      writeWorkspaceClaim(repo, {
        ...own,
        binding_id: `peer-${overlap}`,
        workspace_id: `peer-workspace-${overlap}`,
        request,
        request_sha256: stableDigest(request),
        workspace_root: peerRoot,
        active_root: peerRoot,
      });
      if (overlap === "archived") {
        const runDir = join(repo, ".harnery", "workflows", request.run_id);
        mkdirSync(runDir, { recursive: true });
        writeFileSync(
          join(runDir, "transcript.jsonl"),
          `${JSON.stringify({ event: "run.end", run_id: request.run_id, ok: true })}\n`,
        );
      }
      const before = git(binding.workspace_root, "status", "--porcelain");
      await expect(provider.reclaim(binding, { mode: "discard", yes: true })).rejects.toMatchObject(
        { code: "workflow_reclaim_ownership_unproven" },
      );
      expect(readFileSync(dirtyPath, "utf8")).toBe("owned uncommitted work\n");
      expect(readFileSync(peerFile, "utf8")).toBe("peer recovery work\n");
      expect(git(binding.workspace_root, "status", "--porcelain")).toBe(before);
      expect(
        readWorkspaceEvents(repo, binding.provider.id, binding.binding_id).some(
          (event) => event.event === "cleanup_pending",
        ),
      ).toBe(false);
      expect(readCleanupAttempts(repo, binding.run_id)).toHaveLength(0);
    });
  }
});

describe("workspace generation and probe conformance", () => {
  test("an old completion cannot release the newer lease owner", () => {
    const root = tempRoot("workspace-old-completion");
    roots.push(root);
    const path = join(root, "binding.lease");
    const old = acquireNoClobberLease({
      path,
      scope: "binding",
      authoritySha256: DIGEST,
      staleAfterMs: 1_000,
      now: () => 1_000,
      pid: DEAD_PID,
    });
    const newer = acquireNoClobberLease({
      path,
      scope: "binding",
      authoritySha256: DIGEST,
      staleAfterMs: 1_000,
      now: () => 3_000,
      probePid: () => {
        throw Object.assign(new Error("not found"), { code: "ESRCH" });
      },
    });
    const current = readFileSync(join(path, "current"), "utf8");
    expect(() => old.release()).toThrow();
    expect(readFileSync(join(path, "current"), "utf8")).toBe(current);
    expect(JSON.parse(current).owner_id).toBe(newer.owner.owner_id);
    newer.release();
  });

  test("a reused resource path and PID starts a fresh creation-time observation", () => {
    const root = tempRoot("workspace-generation-observation");
    roots.push(root);
    const path = join(root, "binding.lease");
    const base = { path, scope: "binding", authoritySha256: DIGEST, staleAfterMs: 1_000 };
    acquireNoClobberLease({ ...base, now: () => 1_000, pid: DEAD_PID });
    let missingObservations = 0;
    const recovered = acquireNoClobberLease({
      ...base,
      now: () => 3_000,
      probePid: () => {
        missingObservations++;
        throw Object.assign(new Error("not found"), { code: "ESRCH" });
      },
    });
    recovered.release();
    expect(missingObservations).toBe(1);
    const newGeneration = acquireNoClobberLease({ ...base, now: () => 4_000, pid: DEAD_PID });
    expect(() =>
      acquireNoClobberLease({
        ...base,
        now: () => 4_001,
        probePid: () => {
          missingObservations++;
          throw Object.assign(new Error("old observation"), { code: "ESRCH" });
        },
      }),
    ).toThrow(/live or unexpired/);
    expect(missingObservations).toBe(1);
    expect(JSON.parse(readFileSync(join(path, "current"), "utf8")).created_at).toBe(
      newGeneration.owner.created_at,
    );
    newGeneration.release();
  });

  test("a process-probe error never proves lease absence", () => {
    const root = tempRoot("workspace-probe-unknown");
    roots.push(root);
    const path = join(root, "binding.lease");
    const old = acquireNoClobberLease({
      path,
      scope: "binding",
      authoritySha256: DIGEST,
      staleAfterMs: 1_000,
      now: () => 1_000,
      pid: DEAD_PID,
    });
    const before = readFileSync(join(path, "current"), "utf8");
    expect(() =>
      acquireNoClobberLease({
        path,
        scope: "binding",
        authoritySha256: DIGEST,
        staleAfterMs: 1_000,
        now: () => 3_000,
        probePid: () => {
          throw Object.assign(new Error("cannot inspect"), { code: "EIO" });
        },
      }),
    ).toThrow(/liveness is unknown/);
    expect(readFileSync(join(path, "current"), "utf8")).toBe(before);
    old.release();
  });

  test("an unreadable recovery observation stays unknown across repeated reads", () => {
    const root = tempRoot("workspace-recovery-unknown");
    roots.push(root);
    const runDir = join(root, ".harnery", "workflows", "run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "transcript.jsonl"), "unreadable observation\n");
    expect(readWorkflowLiveness(root, "run")).toBe("unknown");
    expect(readWorkflowLiveness(root, "run")).toBe("unknown");
  });
});

describe("workspace retry and release conformance", () => {
  test("a delayed old terminal failure cannot cancel an explicitly reopened retry", async () => {
    const root = tempRoot("workspace-retry-fence");
    roots.push(root);
    const workflowPath = writeScript(
      root,
      "export default async ({ agent, attempt }) => { if (attempt.number === 1) throw new Error('old failure'); return agent('new intent'); };\n",
    );
    createWorkItem({
      coordRoot: root,
      id: "retry",
      title: "Retry",
      objective: "Keep current intent",
      workflowPath,
      maxAttempts: 3,
    });
    await expect(
      runWorkItem({ coordRoot: root, workId: "retry", engine: { spawners: {}, ...quiet } }),
    ).rejects.toThrow(/old failure/);
    const oldRunId = readWorkItem(root, "retry").projection.latest_run_id!;
    reopenWorkItem(root, "retry", { actor: "operator", reason: "new intent" });
    const completeOld = () => {
      appendFileSync(
        join(root, ".harnery", "workflows", oldRunId, "transcript.jsonl"),
        `${JSON.stringify({ event: "run.end", run_id: oldRunId, ok: false, error: "late old failure" })}\n`,
      );
      return reconcileWorkItem(root, "retry");
    };
    expect(completeOld().projection.state).toBe("ready");
    const entered = handshake<void>();
    const terminal = handshake<SpawnResult>();
    const running = runWorkItem({
      coordRoot: root,
      workId: "retry",
      engine: {
        ...quiet,
        spawners: {
          "claude-code": async () => {
            entered.release();
            return terminal.promise;
          },
        },
      },
    });
    try {
      await entered.promise;
      const current = completeOld();
      expect(current.projection.state).toBe("running");
      expect(current.projection.latest_run_id).not.toBe(oldRunId);
      expect(current.events.filter((event) => event.event === "work.cancelled")).toHaveLength(0);
    } finally {
      terminal.release({ ok: true, text: "new result", durationMs: 1 });
    }
    await running;
    expect(readWorkItem(root, "retry").projection.state).toBe("in_review");
  });

  test.skipIf(!descriptorPathsAvailable)(
    "a cleanup success acknowledgment cannot receipt a still-present resource",
    async () => {
      const { repo, provider, binding, report } = await workspace();
      const acknowledged: WorkspaceProvider = {
        ...provider,
        cleanup: async () => ({
          schema_version: 1,
          binding_id: binding.binding_id,
          status: "released",
          branch_deleted: true,
          recorded_at: new Date().toISOString(),
          attestation: await provider.attest(binding),
        }),
      };
      await expect(
        cleanupWorkspace({ coordRoot: repo, runId: report.runId, provider: acknowledged }),
      ).rejects.toThrow(/invalid result/);
      expect(existsSync(binding.workspace_root)).toBe(true);
      expect(
        existsSync(join(repo, ".harnery", "workflows", report.runId, "cleanup", "receipt.json")),
      ).toBe(false);
      expect(readCleanupAttempts(repo, report.runId).at(-1)?.status).toBe("started");
      expect(
        (await cleanupWorkspace({ coordRoot: repo, runId: report.runId, provider })).status,
      ).toBe("released");
    },
  );
});
