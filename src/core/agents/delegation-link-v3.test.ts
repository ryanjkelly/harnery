import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { initializeEventLedgerV3 } from "../events/v3/bootstrap.ts";
import { sha256V3 } from "../events/v3/canonical.ts";
import type { EventV3 } from "../events/v3/contract.ts";
import {
  projectCoordinationViewV3,
  readCoordinationViewV3,
} from "../events/v3/coordination-view.ts";
import { planDelegationLinksV3 } from "../events/v3/delegation-keys.ts";
import { liveInstanceIdV3 } from "../events/v3/live-route-observer.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../events/v3/live-routing.ts";
import { readLedgerV3 } from "../events/v3/reader.ts";
import {
  linkDelegatedWorkersV3,
  observeDelegatedChildStartV3,
  observeDelegateToolResultV3,
} from "./delegation-link-v3.ts";
import { recordLiveClaimChangeV3, recordLiveLifecycleChangeV3 } from "./live-authority-v3.ts";
import { evaluateClaim } from "./rules/claim-conflict.ts";
import { evaluateCommit } from "./rules/commit-conflict.ts";
import { reconcileSessionFinalizationV3 } from "./session-finalizer-v3.ts";
import { setIdentityCache } from "./state/heartbeat-writer.ts";
import { readLiveCoordinationRows } from "./state/live-coordination-view.ts";
import { ensureLiveCoordinationHeartbeat } from "./state/live-coordination-writer.ts";
import { resolveAgentParentReference } from "./state/parent-reference.ts";

setDefaultTimeout(process.platform === "win32" ? 120_000 : 60_000);

const fixtures: string[] = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) removeDir(path);
});

const KEY = (n: number) =>
  `thread:delegated-task:command%3Amcp%3A00000000-0000-4000-8000-00000000000${n}%3Adelegate-task%3A${n}`;
const S = {
  parent: "dlg-parent",
  first: "dlg-first",
  second: "dlg-second",
  stranger: "dlg-stranger",
} as const;

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-delegation-"));
  fixtures.push(root);
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("config"),
    approvalRecordId: "test-delegation",
  });
  for (const owner of Object.values(S)) start(root, owner);
  return root;
}

function start(root: string, owner: string): void {
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("expected V3 fixture route");
  for (const eventName of ["session-start", "user-prompt-submit"] as const) {
    recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName,
      payload: { session_id: owner, raw: {}, turn_id: `${owner}-turn`, prompt: "work" },
      adapter: "claude-code",
      instanceId: owner,
    });
  }
  ensureLiveCoordinationHeartbeat(root, owner, owner, "claude-code", "fixture");
  setIdentityCache(root, owner, owner.replace("dlg-", ""), `id-${owner}`);
}

function stop(root: string, owner: string): void {
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("expected V3 fixture route");
  recordLiveHookSignalV3({
    coordRoot: root,
    route,
    eventName: "stop",
    payload: { session_id: owner, raw: {}, turn_id: `${owner}-turn` },
    adapter: "claude-code",
    instanceId: owner,
  });
}

function generation(root: string, owner: string): `gen_${string}` {
  const view = readCoordinationViewV3(root);
  const row =
    view.instances[liveInstanceIdV3(owner)] ??
    Object.values(view.terminal_generations).find(
      (candidate) => candidate.instance_id === liveInstanceIdV3(owner),
    );
  if (!row) throw new Error(`no generation for ${owner}`);
  return row.generation_id as `gen_${string}`;
}

function parentDelegates(root: string, key: string) {
  return observeDelegateToolResultV3({
    coordRoot: root,
    generationId: generation(root, S.parent),
    toolName: "mcp__t3-code__delegate_task",
    toolResponse: [
      { type: "text", text: JSON.stringify({ childThreadId: key, status: "running" }) },
    ],
  });
}

function childStarts(root: string, owner: string, key: string) {
  return observeDelegatedChildStartV3({
    coordRoot: root,
    generationId: generation(root, owner),
    adapter: "claude-code",
    env: { T3CODE_THREAD_ID: key },
  });
}

function events(root: string): EventV3[] {
  return readLedgerV3(root).events.map(({ event }) => event);
}

describe("client-delegated worker links", () => {
  test("links in both arrival orders and never on one side alone", () => {
    const root = fixture();
    // Parent first, then child.
    expect(parentDelegates(root, KEY(1)).state).toBe("recorded");
    expect(childStarts(root, S.first, KEY(1)).state).toBe("recorded");
    // Child first, then parent.
    expect(childStarts(root, S.second, KEY(2)).state).toBe("recorded");
    expect(parentDelegates(root, KEY(2)).state).toBe("recorded");
    // A child whose key no parent recorded.
    expect(childStarts(root, S.stranger, KEY(3)).state).toBe("recorded");

    const view = readCoordinationViewV3(root);
    const parentGeneration = generation(root, S.parent);
    for (const owner of [S.first, S.second]) {
      const row = view.instances[liveInstanceIdV3(owner)]!;
      expect(row.parent_generation_id).toBe(parentGeneration);
      expect(row.parent_link).toBe("delegation_key");
      expect(row.delegation_role).toBe("delegated:t3-code");
    }
    expect(view.instances[liveInstanceIdV3(S.stranger)]!.parent_generation_id).toBeUndefined();
    expect(view.authority_safe).toBe(true);

    // The keys themselves never reach the ledger: only fingerprints do.
    const ledger = JSON.stringify(events(root));
    expect(ledger).not.toContain("delegated-task");

    // Running the pass again writes nothing new.
    expect(linkDelegatedWorkersV3(root)).toMatchObject({ linked: 0, completed: 0 });

    const reference = resolveAgentParentReference(root, { instance_id: S.first });
    expect(reference).toMatchObject({
      state: "verified",
      relationship: "delegated-child",
      parent_instance_id: S.parent,
    });
  });

  test("two parents naming one key link nothing", () => {
    const root = fixture();
    parentDelegates(root, KEY(4));
    observeDelegateToolResultV3({
      coordRoot: root,
      generationId: generation(root, S.stranger),
      toolName: "mcp__t3-code__delegate_task",
      toolResponse: { childThreadId: KEY(4) },
    });
    childStarts(root, S.first, KEY(4));
    expect(
      readCoordinationViewV3(root).instances[liveInstanceIdV3(S.first)]!.parent_generation_id,
    ).toBeUndefined();
  });

  test("siblings and their parent share a group; an unrelated session does not", () => {
    const root = fixture();
    parentDelegates(root, KEY(1));
    childStarts(root, S.first, KEY(1));
    childStarts(root, S.second, KEY(2));
    parentDelegates(root, KEY(2));

    const rows = new Map(readLiveCoordinationRows(root).map((row) => [row.instance_id, row]));
    const parentSession = rows.get(S.parent)!.session_id;
    expect(rows.get(S.first)!.session_id).toBe(parentSession);
    expect(rows.get(S.second)!.session_id).toBe(parentSession);
    expect(rows.get(S.first)!.parent_instance_id).toBe(S.parent);
    expect(rows.get(S.stranger)!.session_id).not.toBe(parentSession);
    // A delegated worker keeps its own kind, so its rituals do not change.
    expect(rows.get(S.first)!.kind).not.toBe("subagent");

    const claim = (owner: string, path: string) =>
      recordLiveClaimChangeV3({
        coordRoot: root,
        owner,
        nativeSessionId: owner,
        adapter: "claude-code",
        operation: "acquired",
        path,
      });
    // Each holder also claims a path outside the staged set, so the commit
    // rule cannot treat the holder as the committer under another identity.
    claim(S.second, "sibling.txt");
    claim(S.second, "sibling-other.txt");
    claim(S.stranger, "stranger.txt");
    claim(S.stranger, "stranger-other.txt");

    const edit = (path: string) =>
      evaluateClaim(root, { rule: "claim", instance_id: S.first, session_id: S.first, path });
    expect(edit("sibling.txt").allow).toBe(true);
    expect(edit("stranger.txt").allow).toBe(false);

    const commit = (path: string) =>
      evaluateCommit(root, { staged_paths: [path], instance_id: S.first, session_id: S.first });
    expect(commit("sibling.txt")).toMatchObject({ allow: true, rule: "commit.pass" });
    expect(commit("stranger.txt").allow).toBe(false);
  });

  test("a worker that ends completes its delegation", () => {
    const root = fixture();
    parentDelegates(root, KEY(1));
    childStarts(root, S.first, KEY(1));
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected V3 fixture route");
    stop(root, S.first);
    recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName: "session-end",
      payload: { session_id: S.first, raw: {}, reason: "other" },
      adapter: "claude-code",
      instanceId: S.first,
    });
    expect(linkDelegatedWorkersV3(root).completed).toBe(1);
    const delegation = Object.values(readCoordinationViewV3(root).delegations).find(
      (candidate) => candidate.child_generation_id === generation(root, S.first),
    )!;
    expect(delegation.completed_event_id).toBeDefined();
    expect(linkDelegatedWorkersV3(root).completed).toBe(0);
  });

  test("lifecycle done on an idle worker completes it and the finalizer ends it", () => {
    const root = fixture();
    parentDelegates(root, KEY(1));
    childStarts(root, S.first, KEY(1));
    recordLiveLifecycleChangeV3({
      coordRoot: root,
      owner: S.first,
      nativeSessionId: S.first,
      adapter: "claude-code",
      state: "done",
    });
    // Still in its turn: nothing completes yet.
    expect(linkDelegatedWorkersV3(root).completed).toBe(0);
    stop(root, S.first);
    expect(linkDelegatedWorkersV3(root).completed).toBe(1);
    const child = generation(root, S.first);
    const completed = events(root).find(
      (event) =>
        event.event_type === "agent.completed" && event.payload.child_generation_id === child,
    );
    expect(completed?.event_type).toBe("agent.completed");
    reconcileSessionFinalizationV3(root, { archive_observations: [] });
    reconcileSessionFinalizationV3(root, { archive_observations: [] });
    const view = readCoordinationViewV3(root);
    expect(view.instances[liveInstanceIdV3(S.first)]).toBeUndefined();
    expect(view.terminal_generations[child]).toBeDefined();
    // The parent keeps running.
    expect(view.instances[liveInstanceIdV3(S.parent)]).toBeDefined();
  });

  test("a ledger without delegation keys plans nothing and links nothing", () => {
    const root = fixture();
    const read = readLedgerV3(root);
    expect(
      planDelegationLinksV3(
        read.events.map(({ event }) => event),
        projectCoordinationViewV3(read),
      ),
    ).toEqual({
      links: [],
      completions: [],
    });
    for (const row of Object.values(readCoordinationViewV3(root).instances)) {
      expect(row.parent_generation_id).toBeUndefined();
      expect(row.parent_link).toBeUndefined();
    }
  });
});
