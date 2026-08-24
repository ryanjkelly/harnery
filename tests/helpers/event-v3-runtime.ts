import type { Adapter } from "../../src/core/adapter.ts";
import {
  recordLiveClaimChangeV3,
  recordLiveIdentityChangeV3,
  recordLiveLifecycleChangeV3,
  recordLiveTaskChangeV3,
} from "../../src/core/agents/live-authority-v3.ts";
import { ensureLiveCoordinationHeartbeat } from "../../src/core/agents/state/live-coordination-writer.ts";
import { initializeEventLedgerV3 } from "../../src/core/events/v3/bootstrap.ts";
import { sha256V3 } from "../../src/core/events/v3/canonical.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../../src/core/events/v3/live-routing.ts";

export function initializeV3Fixture(root: string): void {
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("fixture-config"),
    approvalRecordId: "test-v3-universal",
  });
}

export function seedV3Session(
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
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error(`fixture_v3_route:${route.reason}`);
  const started = recordLiveHookSignalV3({
    coordRoot: root,
    route,
    eventName: "session-start",
    adapter,
    instanceId: id,
    payload: { session_id: sessionId, raw: {} },
  });
  if (started.state !== "recorded" && started.state !== "already_started") {
    throw new Error(`fixture_v3_start:${started.state}`);
  }
  if (!ensureLiveCoordinationHeartbeat(root, id, sessionId, adapter)) {
    throw new Error(`fixture_v3_cache:${id}`);
  }
  if (options.name) {
    recordLiveIdentityChangeV3({
      coordRoot: root,
      owner: id,
      nativeSessionId: sessionId,
      adapter,
      name: options.name,
      identityId: `identity-${id}`,
    });
  }
  if (options.task !== undefined) {
    recordLiveTaskChangeV3({
      coordRoot: root,
      owner: id,
      nativeSessionId: sessionId,
      adapter,
      task: options.task,
    });
  }
  for (const path of options.claims ?? []) {
    recordLiveClaimChangeV3({
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
    recordLiveLifecycleChangeV3({
      coordRoot: root,
      owner: id,
      nativeSessionId: sessionId,
      adapter,
      state: options.lifecycle,
      reason: options.lifecycleReason,
    });
  }
}
