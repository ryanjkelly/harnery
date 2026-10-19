import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  descriptorPathsAvailable,
  git,
  gitFixture,
  quiet,
  writeScript,
} from "../../../../tests/workspace-test-helpers.ts";
import { runWorkflow } from "../engine.ts";
import { createLocalGitWorktreeProvider } from "./local-git.ts";
import { readWorkspaceClaim, workspaceClaimPath, writeWorkspaceClaim } from "./state.ts";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function allocated(coordRoot?: string) {
  const { host, repo } = gitFixture("reservation-crash");
  roots.push(host);
  const script = writeScript(repo, "export default async () => 'done';\n");
  git(repo, "add", "scripts");
  git(repo, "commit", "-qm", "workflow");
  const coord = coordRoot ?? repo;
  const provider = createLocalGitWorktreeProvider({ coordRoot: coord });
  const report = await runWorkflow(script, {
    coordRoot: coord,
    cwd: repo,
    spawners: {},
    isolation: "worktree",
    workspace: { provider, writableRoots: [host] },
    ...quiet,
  });
  const binding = report.workspaceBinding!;
  const claim = readWorkspaceClaim(coord, binding.provider.id, binding.binding_id)!;
  return { host, repo, coord, provider, binding, claim };
}

function start(root: string, bindingPath: string, mode: string) {
  const child = spawn(
    process.execPath,
    [
      join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/reclaim-crash.ts"),
      root,
      bindingPath,
      mode,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(child);
  let stdout = "";
  let stderr = "";
  const reserved = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes("RESERVED ")) resolve();
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!stdout.includes("RESERVED "))
        reject(new Error(`reservation fixture exited ${code}/${signal}: ${stderr}`));
    });
  });
  return { child, reserved, output: () => ({ stdout, stderr }) };
}

describe.skipIf(!descriptorPathsAvailable)("killed reclaim reservation recovery", () => {
  test("an expired live owner blocks publication; a killed exact owner is recovered without releasing peer work", async () => {
    const outer = await allocated();
    const peer = await allocated(outer.coord);
    const peerClaimPath = workspaceClaimPath(
      outer.coord,
      peer.claim.provider_id,
      peer.claim.binding_id,
    );
    renameSync(peerClaimPath, join(peer.host, "withheld-claim.json"));
    renameSync(peer.binding.workspace_root, `${peer.binding.workspace_root}-retained`);
    symlinkSync(outer.binding.workspace_root, peer.binding.workspace_root, "dir");
    const dirtyPath = join(outer.binding.workspace_root, "README.md");
    writeFileSync(dirtyPath, "retained work after crash\n");
    const before = {
      head: git(outer.binding.workspace_root, "rev-parse", "HEAD"),
      status: git(outer.binding.workspace_root, "status", "--porcelain"),
      claim: readFileSync(
        workspaceClaimPath(outer.coord, outer.claim.provider_id, outer.claim.binding_id),
        "utf8",
      ),
    };
    const bindingPath = join(outer.host, "binding.json");
    writeFileSync(bindingPath, JSON.stringify(outer.binding));
    const leaseDir = join(
      outer.coord,
      ".harnery/workspaces",
      outer.claim.provider_id,
      ".leases",
      `reclaim-${outer.claim.binding_id}.lock`,
    );
    const currentPath = join(leaseDir, "current");
    const original = start(outer.coord, bindingPath, "reclaim");
    await original.reserved;
    const originalOwner = JSON.parse(readFileSync(currentPath, "utf8"));
    expect(originalOwner.pid).toBe(original.child.pid);
    expect(Date.parse(originalOwner.expires_at)).toBeLessThan(Date.now());
    expect(() => writeWorkspaceClaim(outer.coord, peer.claim)).toThrow("lease workspace-reclaim");
    expect(existsSync(peerClaimPath)).toBe(false);
    expect(JSON.parse(readFileSync(currentPath, "utf8"))).toEqual(originalOwner);
    expect(readFileSync(dirtyPath, "utf8")).toBe("retained work after crash\n");
    const killed = once(original.child, "exit");
    expect(original.child.kill("SIGKILL")).toBe(true);
    expect((await killed)[1]).toBe("SIGKILL");
    expect(() => process.kill(originalOwner.pid, 0)).toThrow();

    const recovered = start(outer.coord, bindingPath, "recover");
    await recovered.reserved;
    const newOwner = JSON.parse(readFileSync(currentPath, "utf8"));
    expect(newOwner.pid).toBe(recovered.child.pid);
    expect(newOwner.owner_id).not.toBe(originalOwner.owner_id);
    expect(existsSync(join(leaseDir, originalOwner.owner_file))).toBe(false);
    expect(
      readFileSync(
        workspaceClaimPath(outer.coord, outer.claim.provider_id, outer.claim.binding_id),
        "utf8",
      ),
    ).toBe(before.claim);
    expect(readFileSync(dirtyPath, "utf8")).toBe("retained work after crash\n");
    expect(git(outer.binding.workspace_root, "rev-parse", "HEAD")).toBe(before.head);
    expect(git(outer.binding.workspace_root, "status", "--porcelain")).toBe(before.status);
    expect(() => writeWorkspaceClaim(outer.coord, peer.claim)).toThrow("lease workspace-reclaim");
    const released = once(recovered.child, "exit");
    recovered.child.stdin.write("x");
    expect(await released).toEqual([0, null]);
    expect(recovered.output().stderr).toBe("");
    expect(recovered.output().stdout).toContain("RELEASED");
    expect(existsSync(currentPath)).toBe(false);
    expect(writeWorkspaceClaim(outer.coord, peer.claim)).toBe(true);
    await expect(
      outer.provider.reclaim(outer.binding, { mode: "discard", yes: true }),
    ).rejects.toMatchObject({ code: "workflow_reclaim_ownership_unproven" });
    expect(readWorkspaceClaim(outer.coord, peer.claim.provider_id, peer.claim.binding_id)).toEqual(
      peer.claim,
    );
    expect(readFileSync(dirtyPath, "utf8")).toBe("retained work after crash\n");
    expect(git(outer.binding.workspace_root, "status", "--porcelain")).toBe(before.status);
  }, 30_000);
});
