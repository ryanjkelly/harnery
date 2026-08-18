import type { Adapter } from "../../src/core/adapter.ts";
import {
  recordLiveClaimChangeV2,
  recordLiveIdentityChangeV2,
  recordLiveLifecycleChangeV2,
  recordLiveTaskChangeV2,
} from "../../src/core/agents/live-authority-v2.ts";
import { ensureLiveCoordinationHeartbeat } from "../../src/core/agents/state/live-coordination-view.ts";
import { initializeEventLedgerV2 } from "../../src/core/events/v2/bootstrap.ts";
import { sha256V2 } from "../../src/core/events/v2/canonical.ts";
import {
  recordLiveHookSignalV2,
  resolveLiveEventLedgerRouteV2,
} from "../../src/core/events/v2/live-routing.ts";

export function initializeV2Fixture(root: string): void {
  initializeEventLedgerV2({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V2("fixture-config"),
    approvalRecordId: "test-v2-universal",
  });
}

export function seedV2Session(
  root: string,
  id: string,
  options: {
    name?: string;
    sessionId?: string;
    adapter?: Adapter;
    task?: string;
    claims?: string[];
    lifecycle?: "active" | "blocked" | "done";
    lifecycleReason?: string;
  } = {},
): void {
  const adapter = options.adapter ?? "codex";
  const sessionId = options.sessionId ?? id;
  const route = resolveLiveEventLedgerRouteV2(root);
  if (route.state !== "v2") throw new Error(`fixture_v2_route:${route.reason}`);
  const started = recordLiveHookSignalV2({
    coordRoot: root,
    route,
    eventName: "session-start",
    adapter,
    instanceId: id,
    payload: { session_id: sessionId, raw: {} },
  });
  if (started.state !== "recorded" && started.state !== "already_started") {
    throw new Error(`fixture_v2_start:${started.state}`);
  }
  if (!ensureLiveCoordinationHeartbeat(root, id, sessionId, adapter)) {
    throw new Error(`fixture_v2_cache:${id}`);
  }
  if (options.name) {
    recordLiveIdentityChangeV2({
      coordRoot: root,
      owner: id,
      nativeSessionId: sessionId,
      adapter,
      name: options.name,
      identityId: `identity-${id}`,
    });
  }
  if (options.task !== undefined) {
    recordLiveTaskChangeV2({
      coordRoot: root,
      owner: id,
      nativeSessionId: sessionId,
      adapter,
      task: options.task,
    });
  }
  for (const path of options.claims ?? []) {
    recordLiveClaimChangeV2({
      coordRoot: root,
      owner: id,
      nativeSessionId: sessionId,
      adapter,
      operation: "acquired",
      path,
      access: "write",
    });
  }
  if (options.lifecycle && options.lifecycle !== "active") {
    recordLiveLifecycleChangeV2({
      coordRoot: root,
      owner: id,
      nativeSessionId: sessionId,
      adapter,
      state: options.lifecycle,
      reason: options.lifecycleReason,
    });
  }
}
