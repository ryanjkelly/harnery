import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJsonRecord, stableDigest, writeImmutableJson } from "../workflow/durable-record.ts";
import { acquireNoClobberLease } from "../workflow/workspaces/leases.ts";
import { createLocalGitWorktreeProvider } from "../workflow/workspaces/local-git.ts";
import {
  claimOverlapsWorkspace,
  reserveWorkspaceReclaim,
} from "../workflow/workspaces/ownership.ts";
import { descriptorBackedPathsSupported } from "../workflow/workspaces/paths.ts";
import { readWorkflowLiveness } from "../workflow/workspaces/recovery.ts";
import {
  appendWorkspaceEvent,
  readWorkspaceClaim,
  readWorkspaceClaims,
  workspaceLockPath,
} from "../workflow/workspaces/state.ts";
import type { WorkspaceBinding } from "../workflow/workspaces/types.ts";
import {
  type ContentEntry,
  type ContentSnapshot,
  currentMatches,
  ensureDirectory,
  git,
  lockIndex,
  observe,
  persistSnapshot,
  restoreFile,
  safePaths,
  stageBefore,
  verifySnapshot,
} from "./content.ts";

export type { ContentEntry, ContentSnapshot } from "./content.ts";
export type TurnIdentity = { turn_id: string; generation: number };
export interface TurnCapture {
  schema_version: 1;
  capture_id: string;
  binding_sha256: string;
  binding_generation: number;
  turn: TurnIdentity;
  paths: string[];
  before: ContentSnapshot;
  sha256: string;
  end?: ContentSnapshot;
}
export interface TurnRollbackPlan {
  schema_version: 1;
  capture_id: string;
  binding_sha256: string;
  turn: TurnIdentity;
  before_sha256: string;
  end_sha256: string;
  paths: Array<{ path: string; before: ContentEntry; end: ContentEntry }>;
  plan_sha256: string;
}
export interface TurnRollbackResult {
  schema_version: 1;
  status: "preview" | "applied" | "already_applied" | "unknown";
  capture_id: string;
  plan_sha256: string;
  reason?: string;
}
export interface TurnRollbackStatus {
  status: "missing" | "open" | "sealed" | "applied" | "unknown";
  capture_id: string;
}
type CaptureInput = { binding: WorkspaceBinding; capture_id: string };
interface Scope {
  binding: WorkspaceBinding;
  state: string;
  store: string;
  guard(): Promise<void>;
  audit(event: string, data: Record<string, unknown>): void;
}
const PROVIDER = "local-git-worktree";
const CAPTURE = /^turn-[a-f0-9]{32}$/;
const TOTAL_LIMIT = 64 * 1024 * 1024;

function statePath(coordRoot: string, binding: WorkspaceBinding): string {
  if (
    binding?.provider?.id !== PROVIDER ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(binding.binding_id)
  )
    throw new Error("exclusive local provider binding is required");
  return join(resolve(coordRoot), ".harnery", "turn-rollback", PROVIDER, binding.binding_id);
}
function capturePath(scope: Pick<Scope, "state">, id: string, name: string): string {
  if (!CAPTURE.test(id)) throw new Error("invalid capture id");
  return join(scope.state, "captures", id, name);
}
function record<T>(path: string): T {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error("rollback record is unsafe");
  return readJsonRecord<T>(path, "turn rollback record");
}
function load(scope: Pick<Scope, "state" | "binding">, id: string): TurnCapture {
  if (!existsSync(capturePath(scope, id, "begin.json")))
    throw new Error("capture outcome is unknown; incomplete pending capture blocks further turns");
  const capture = record<TurnCapture>(capturePath(scope, id, "begin.json"));
  const { sha256, end: invalidEnd, ...basis } = capture;
  if (
    invalidEnd ||
    sha256 !== stableDigest(basis) ||
    capture.schema_version !== 1 ||
    capture.capture_id !== id ||
    capture.binding_sha256 !== stableDigest(scope.binding) ||
    capture.binding_generation !== scope.binding.generation ||
    !Number.isSafeInteger(capture.turn?.generation) ||
    capture.turn.generation < 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(capture.turn?.turn_id) ||
    stableDigest(safePaths(scope.binding, capture.paths)) !== stableDigest(capture.paths) ||
    stableDigest(capture.before.entries.map((entry) => entry.path)) !== stableDigest(capture.paths)
  )
    throw new Error("capture authority changed");
  const sealed = capturePath(scope, id, "end.json");
  if (existsSync(sealed)) {
    const end = record<{ capture_sha256: string; snapshot: ContentSnapshot }>(sealed);
    if (
      end.capture_sha256 !== sha256 ||
      stableDigest(end.snapshot.entries.map((entry) => entry.path)) !== stableDigest(capture.paths)
    )
      throw new Error("sealed capture authority changed");
    return { ...capture, end: end.snapshot };
  }
  if (existsSync(capturePath(scope, id, "seal-pending.json")))
    throw new Error("seal outcome is unknown; incomplete pending snapshot blocks further turns");
  return capture;
}
function allCaptures(scope: Pick<Scope, "state" | "binding">): TurnCapture[] {
  const root = join(scope.state, "captures");
  if (!existsSync(root)) return [];
  const captures = readdirSync(root)
    .map((id) => load(scope, id))
    .sort((a, b) => a.turn.generation - b.turn.generation);
  if (
    captures.length > 64 ||
    new Set(captures.map((c) => c.turn.generation)).size !== captures.length
  )
    throw new Error("capture generation or retention limit is invalid");
  return captures;
}
function latest(scope: Pick<Scope, "state" | "binding">, id: string): TurnCapture {
  const capture = allCaptures(scope).at(-1);
  if (!capture || capture.capture_id !== id)
    throw new Error("restore requires the latest turn capture");
  return capture;
}
function usage(captures: TurnCapture[]): number {
  return captures.reduce((sum, c) => sum + c.before.total_bytes + (c.end?.total_bytes ?? 0), 0);
}

async function withScope<T>(
  coordRoot: string,
  binding: WorkspaceBinding,
  operation: (scope: Scope) => Promise<T>,
): Promise<T> {
  const state = statePath(coordRoot, binding);
  if (!descriptorBackedPathsSupported())
    throw new Error("descriptor-backed containment is unsupported");
  const provider = createLocalGitWorktreeProvider({ coordRoot });
  await provider.readBinding(binding);
  const claim = readWorkspaceClaim(coordRoot, PROVIDER, binding.binding_id)!;
  const authority = stableDigest({
    binding_id: claim.binding_id,
    request_sha256: claim.request_sha256,
    scope: "binding",
  });
  const path = workspaceLockPath(coordRoot, PROVIDER, binding.binding_id);
  const lease = acquireNoClobberLease({
    path,
    scope: "binding",
    authoritySha256: authority,
    staleAfterMs: 300_000,
    metadata: { binding_id: claim.binding_id, request_sha256: claim.request_sha256 },
    validateStaleOwner: (owner) =>
      owner.authority_sha256 === authority &&
      owner.metadata?.binding_id === claim.binding_id &&
      owner.metadata?.request_sha256 === claim.request_sha256,
  });
  try {
    const reservation = reserveWorkspaceReclaim(coordRoot, claim);
    try {
      const guard = async () => {
        reservation.assertCurrent();
        const ownerPath = join(path, lease.owner.owner_file);
        const current = join(path, "current");
        const a = lstatSync(current, { bigint: true });
        const b = lstatSync(ownerPath, { bigint: true });
        if (
          !a.isFile() ||
          a.dev !== b.dev ||
          a.ino !== b.ino ||
          readFileSync(current, "utf8") !== readFileSync(ownerPath, "utf8") ||
          stableDigest(record(current)) !== stableDigest(lease.owner)
        )
          throw new Error("binding lease changed");
        await provider.readBinding(binding);
        const attestation = await provider.attest(binding);
        if (
          attestation.status !== "ok" ||
          attestation.resource_state !== "active" ||
          attestation.repository?.conflicts.length ||
          attestation.repository?.operation_in_progress.length
        )
          throw new Error("workspace ownership is unproven");
        for (const peer of readWorkspaceClaims(coordRoot, PROVIDER)) {
          if (
            peer.binding_id !== binding.binding_id &&
            claimOverlapsWorkspace(peer, claim.workspace_root)
          )
            throw new Error(`retained peer ${peer.binding_id} overlaps rollback workspace`);
        }
      };
      await guard();
      ensureDirectory(state);
      const store = join(state, "content.git");
      if (!existsSync(store)) git(state, ["init", "--bare", "-q", store]);
      ensureDirectory(store);
      return await operation({
        binding,
        state,
        store,
        guard,
        audit: (event, data) => {
          appendWorkspaceEvent(coordRoot, claim, `turn_rollback.${event}`, data);
        },
      });
    } finally {
      reservation.release();
    }
  } finally {
    lease.release();
  }
}

/** Capture the exact named files before a turn, without staging anything. */
export async function beginTurnRollback(
  coordRoot: string,
  input: {
    binding: WorkspaceBinding;
    turn: TurnIdentity;
    paths: readonly string[];
    onSnapshotStep?: (step: "content_persisted", captureId: string) => void;
  },
): Promise<TurnCapture> {
  return withScope(coordRoot, input.binding, async (scope) => {
    if (
      !input.turn ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.turn.turn_id) ||
      !Number.isSafeInteger(input.turn.generation) ||
      input.turn.generation < 1
    )
      throw new Error("invalid turn identity");
    const paths = safePaths(input.binding, input.paths);
    const prior = allCaptures(scope);
    const last = prior.at(-1);
    if (
      last &&
      (!last.end ||
        input.turn.generation <= last.turn.generation ||
        inspectTurnRollback(coordRoot, { binding: input.binding, capture_id: last.capture_id })
          .status === "unknown")
    )
      throw new Error("latest turn is open, unknown, or newer");
    if (prior.length >= 64) throw new Error("capture count limit exceeded");
    const index = lockIndex(input.binding, scope.state);
    try {
      const observed = observe(input.binding, scope.store, paths);
      if (usage(prior) + observed.total > TOTAL_LIMIT)
        throw new Error("binding retention byte limit exceeded");
      await scope.guard();
      const binding_sha256 = stableDigest(input.binding);
      const capture_id = `turn-${stableDigest({ binding_sha256, turn: input.turn, paths }).slice(0, 32)}`;
      ensureDirectory(join(scope.state, "captures", capture_id));
      writeImmutableJson(capturePath(scope, capture_id, "pending.json"), {
        schema_version: 1,
        capture_id,
        binding_sha256,
        turn: input.turn,
        paths,
        phase: "before",
        total_bytes: observed.total,
      });
      const before = persistSnapshot(scope.store, observed, `${capture_id}/before`);
      input.onSnapshotStep?.("content_persisted", capture_id);
      const basis = {
        schema_version: 1 as const,
        capture_id,
        binding_sha256,
        binding_generation: input.binding.generation,
        turn: { ...input.turn },
        paths,
        before,
      };
      const capture = { ...basis, sha256: stableDigest(basis) };
      writeImmutableJson(capturePath(scope, capture_id, "begin.json"), capture);
      scope.audit("captured", {
        capture_id,
        capture_sha256: capture.sha256,
        turn: capture.turn,
        paths,
      });
      return capture;
    } finally {
      index.close();
    }
  });
}

/** Seal the end boundary of the latest captured turn. */
export async function sealTurnRollback(
  coordRoot: string,
  input: CaptureInput & { onSnapshotStep?: (step: "content_persisted", captureId: string) => void },
): Promise<TurnCapture> {
  return withScope(coordRoot, input.binding, async (scope) => {
    const capture = latest(scope, input.capture_id);
    verifySnapshot(scope.store, capture.before);
    const index = lockIndex(input.binding, scope.state);
    try {
      if (capture.end) {
        verifySnapshot(scope.store, capture.end);
        if (!currentMatches(input.binding, scope.store, capture.end))
          throw new Error("sealed content changed");
        return capture;
      }
      const observed = observe(input.binding, scope.store, capture.paths);
      if (observed.head !== capture.before.head) throw new Error("HEAD changed during turn");
      if (usage(allCaptures(scope)) + observed.total > TOTAL_LIMIT)
        throw new Error("binding retention byte limit exceeded");
      await scope.guard();
      writeImmutableJson(capturePath(scope, capture.capture_id, "seal-pending.json"), {
        schema_version: 1,
        capture_id: capture.capture_id,
        binding_sha256: stableDigest(input.binding),
        turn: capture.turn,
        paths: capture.paths,
        phase: "end",
        total_bytes: observed.total,
      });
      const end = persistSnapshot(scope.store, observed, `${capture.capture_id}/end`);
      input.onSnapshotStep?.("content_persisted", capture.capture_id);
      writeImmutableJson(capturePath(scope, capture.capture_id, "end.json"), {
        capture_sha256: capture.sha256,
        snapshot: end,
      });
      scope.audit("sealed", {
        capture_id: capture.capture_id,
        capture_sha256: capture.sha256,
        end_sha256: end.sha256,
      });
      return { ...capture, end };
    } finally {
      index.close();
    }
  });
}

function planFor(capture: TurnCapture): TurnRollbackPlan {
  if (!capture.end) throw new Error("turn capture is not sealed");
  const basis = {
    schema_version: 1 as const,
    capture_id: capture.capture_id,
    binding_sha256: capture.binding_sha256,
    turn: capture.turn,
    before_sha256: capture.before.sha256,
    end_sha256: capture.end.sha256,
    paths: capture.paths.map((path, index) => ({
      path,
      before: capture.before.entries[index]!,
      end: capture.end!.entries[index]!,
    })),
  };
  return { ...basis, plan_sha256: stableDigest(basis) };
}

/** Produce a dry-run exact-path proposal bound to both captured boundaries. */
export async function prepareTurnRollback(
  coordRoot: string,
  input: CaptureInput,
): Promise<TurnRollbackPlan> {
  return withScope(coordRoot, input.binding, async (scope) => {
    const capture = latest(scope, input.capture_id);
    const plan = planFor(capture);
    verifySnapshot(scope.store, capture.before);
    verifySnapshot(scope.store, capture.end!);
    const index = lockIndex(input.binding, scope.state);
    try {
      if (!currentMatches(input.binding, scope.store, capture.end!))
        throw new Error("selected content or HEAD changed since seal");
      return plan;
    } finally {
      index.close();
    }
  });
}

export async function applyTurnRollback(
  coordRoot: string,
  input: {
    binding: WorkspaceBinding;
    plan: TurnRollbackPlan;
    yes?: boolean;
    actor?: string;
    reason?: string;
    /** Observation/fault boundary; does not replace any authority or content guard. */
    onStep?: (step: "started" | "worktree_published" | "index_published") => void;
  },
): Promise<TurnRollbackResult> {
  if (
    inspectTurnRollback(coordRoot, { binding: input.binding, capture_id: input.plan.capture_id })
      .status === "unknown"
  )
    throw new Error("rollback outcome is unknown; automatic retry is refused");
  return withScope(coordRoot, input.binding, async (scope) => {
    const capture = latest(scope, input.plan.capture_id);
    const expected = planFor(capture);
    if (stableDigest(input.plan) !== stableDigest(expected))
      throw new Error("rollback proposal digest changed");
    verifySnapshot(scope.store, capture.before);
    verifySnapshot(scope.store, capture.end!);
    const result = {
      schema_version: 1 as const,
      capture_id: capture.capture_id,
      plan_sha256: expected.plan_sha256,
    };
    const receiptPath = capturePath(scope, capture.capture_id, "receipt.json");
    const startedPath = capturePath(scope, capture.capture_id, "started.json");
    const index = lockIndex(input.binding, scope.state);
    try {
      if (existsSync(receiptPath)) {
        const receipt = record<TurnRollbackResult>(receiptPath);
        if (
          receipt.schema_version !== 1 ||
          receipt.status !== "applied" ||
          receipt.plan_sha256 !== expected.plan_sha256 ||
          receipt.capture_id !== capture.capture_id ||
          !currentMatches(input.binding, scope.store, capture.before)
        )
          throw new Error("applied receipt or restored content changed");
        return { ...result, status: "already_applied" };
      }
      if (!currentMatches(input.binding, scope.store, capture.end!))
        throw new Error("selected content or HEAD changed since proposal");
      if (!input.yes) return { ...result, status: "preview" };
      if (
        !input.actor?.trim() ||
        !input.reason?.trim() ||
        input.actor.length > 200 ||
        input.reason.length > 1000
      )
        throw new Error("actor and reason are required and bounded");
      if (readWorkflowLiveness(coordRoot, input.binding.run_id) !== "inactive")
        throw new Error("workflow must be proven inactive before rollback");
      await scope.guard();
      scope.audit("apply_requested", {
        ...result,
        turn: capture.turn,
        actor: input.actor,
        reason: input.reason,
        paths: capture.paths,
      });
      writeImmutableJson(startedPath, {
        ...result,
        turn: capture.turn,
        actor: input.actor,
        reason: input.reason,
      });
      try {
        input.onStep?.("started");
        // Each published path changes the expected worktree for subsequent guards.
        const progress: ContentSnapshot = structuredClone(capture.end!);
        for (const [position, entry] of capture.before.entries.entries()) {
          await scope.guard();
          if (
            readWorkflowLiveness(coordRoot, input.binding.run_id) !== "inactive" ||
            !currentMatches(input.binding, scope.store, progress)
          )
            throw new Error("content or workflow changed during restore");
          restoreFile(input.binding, scope.store, entry);
          progress.entries[position]!.worktree = entry.worktree;
          progress.entries[position]!.untracked =
            !progress.entries[position]!.index && entry.worktree !== null;
          input.onStep?.("worktree_published");
        }
        await scope.guard();
        if (
          readWorkflowLiveness(coordRoot, input.binding.run_id) !== "inactive" ||
          !currentMatches(input.binding, scope.store, progress)
        )
          throw new Error("content or workflow changed before index publication");
        stageBefore(input.binding, scope.store, capture.before, index);
        await scope.guard();
        if (
          readWorkflowLiveness(coordRoot, input.binding.run_id) !== "inactive" ||
          !currentMatches(input.binding, scope.store, progress)
        )
          throw new Error("content changed before index publication");
        index.publish();
        input.onStep?.("index_published");
        await scope.guard();
        if (
          readWorkflowLiveness(coordRoot, input.binding.run_id) !== "inactive" ||
          !currentMatches(input.binding, scope.store, capture.before)
        )
          throw new Error("restored content verification failed");
        const receipt: TurnRollbackResult = { ...result, status: "applied" };
        scope.audit("applied", { ...result, turn: capture.turn, paths: capture.paths });
        writeImmutableJson(receiptPath, receipt);
        return receipt;
      } catch (error) {
        scope.audit("unknown", { ...result, reason: String(error).slice(0, 1000) });
        return { ...result, status: "unknown", reason: String(error) };
      }
    } finally {
      index.close();
    }
  });
}

/** Read recovery evidence without attempting to continue an interrupted restore. */
export function inspectTurnRollback(coordRoot: string, input: CaptureInput): TurnRollbackStatus {
  const state = statePath(coordRoot, input.binding);
  const scope = { state, binding: input.binding };
  const beginPath = capturePath(scope, input.capture_id, "begin.json");
  if (!existsSync(beginPath)) {
    const pending = capturePath(scope, input.capture_id, "pending.json");
    if (!existsSync(pending)) return { status: "missing", capture_id: input.capture_id };
    const reservation = record<{
      schema_version: number;
      capture_id: string;
      binding_sha256: string;
    }>(pending);
    if (
      reservation.schema_version !== 1 ||
      reservation.capture_id !== input.capture_id ||
      reservation.binding_sha256 !== stableDigest(input.binding)
    )
      throw new Error("pending capture authority changed");
    return { status: "unknown", capture_id: input.capture_id };
  }
  if (
    existsSync(capturePath(scope, input.capture_id, "seal-pending.json")) &&
    !existsSync(capturePath(scope, input.capture_id, "end.json"))
  )
    return { status: "unknown", capture_id: input.capture_id };
  const capture = load(scope, input.capture_id);
  const started = existsSync(capturePath(scope, input.capture_id, "started.json"));
  const receipt = existsSync(capturePath(scope, input.capture_id, "receipt.json"));
  if (started) {
    const pending = record<{
      schema_version: number;
      capture_id: string;
      plan_sha256: string;
      turn: TurnIdentity;
    }>(capturePath(scope, input.capture_id, "started.json"));
    if (
      pending.schema_version !== 1 ||
      pending.capture_id !== capture.capture_id ||
      pending.plan_sha256 !== planFor(capture).plan_sha256 ||
      stableDigest(pending.turn) !== stableDigest(capture.turn)
    )
      throw new Error("started restore authority changed");
  }
  if (receipt) {
    const value = record<TurnRollbackResult>(capturePath(scope, input.capture_id, "receipt.json"));
    if (
      !started ||
      value.schema_version !== 1 ||
      value.status !== "applied" ||
      value.capture_id !== capture.capture_id ||
      value.plan_sha256 !== planFor(capture).plan_sha256
    )
      throw new Error("restore receipt is unproven");
  }
  return {
    status: started ? (receipt ? "applied" : "unknown") : capture.end ? "sealed" : "open",
    capture_id: input.capture_id,
  };
}
