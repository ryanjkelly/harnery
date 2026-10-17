import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { initializeEventLedgerV3 } from "../events/v3/bootstrap.ts";
import { sha256V3 } from "../events/v3/canonical.ts";
import { resolveLiveEventLedgerRouteV3 } from "../events/v3/live-routing.ts";
import {
  readHookProducerStateV3,
  recordApprovedSessionEndV3,
  recordHookSignalV3,
} from "../events/v3/producers/recorder.ts";
import { planInboxCompaction } from "../inbox/lifecycle.ts";
import { PEER_INBOX_LIMITS, peerInbox, sendPeerMessage } from "../inbox/peer-messages.ts";
import { inboxPath } from "../inbox/service.ts";
import { watchInbox } from "../inbox/watcher.ts";
import { reopenLiveCoordinationGenerationV3 } from "./live-authority-v3.ts";
import { renderPromptContext } from "./render/prompt-context.ts";

const roots: string[] = [];
const old = "2026-08-28T22:00:00.000Z";
const later = new Date("2026-08-28T22:30:00.000Z");
const DAY = 24 * 60 * 60_000;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "harnery-stale-ping-acceptance-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("fixture"),
    approvalRecordId: "stale-ping-acceptance",
  });
  return root;
}

function session(root: string, owner: string, name: string, observedAt = old) {
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("fixture requires V3");
  expect(
    recordHookSignalV3({
      coordRoot: root,
      mode: route.mode,
      signal: "session-start",
      payload: { session_id: owner, raw: {} },
      adapter: "codex",
      instance_id: `inst_${owner}`,
      producer_id: "prd_stale-ping-acceptance",
      build_id: route.build_id,
      platform: "linux",
      observed_at: observedAt,
    }).state,
  ).toBe("recorded");
  appendFileSync(
    join(root, ".harnery/.name-history"),
    `${JSON.stringify({ instance_id: owner, name, kind: "session", ts: observedAt })}\n`,
  );
}

function send(root: string, recipient: string, body: string) {
  const result = sendPeerMessage({
    coordRoot: root,
    target: { instanceId: recipient, now: later },
    senderInstanceId: "sender",
    senderName: "Talia",
    body,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result;
}

describe("stale active message acceptance", () => {
  test("a queued ping survives an abandoned prompt emission and is acknowledged only after surfacing", () => {
    const root = fixture();
    session(root, "stale-active", "Maya");
    const receipt = send(root, "stale-active", "STALE_ACTIVE_PRIVATE_FIXTURE");
    expect(receipt).toMatchObject({
      state: "queued",
      synced: true,
      target: { instance_id: "stale-active" },
    });
    const service = peerInbox(root);
    expect(service.status("stale-active")).toMatchObject({ pending_count: 1 });
    let prepared: readonly string[] = [];
    const prompt = () =>
      renderPromptContext({
        coordRoot: root,
        instanceId: "stale-active",
        sessionId: "stale-active",
        agentName: "Maya",
        onInboxPrepared: (ids) => {
          prepared = ids;
        },
      });
    expect(prompt()).toContain("STALE_ACTIVE_PRIVATE_FIXTURE");
    expect(prepared).toEqual([receipt.message_id]);
    expect(service.pending("stale-active")).toHaveLength(1);
    // Simulate a crash before the output acknowledgement, then resume the
    // exact instance. The second render must repeat rather than drop it.
    expect(prompt()).toContain("STALE_ACTIVE_PRIVATE_FIXTURE");
    service.acknowledgeSurface("stale-active", prepared);
    expect(service.pending("stale-active")).toEqual([]);
    expect(prompt()).not.toContain("STALE_ACTIVE_PRIVATE_FIXTURE");
    expect(service.records("stale-active").map((record) => record.kind)).toEqual([
      "message",
      "surfaced",
    ]);
    expect(statSync(inboxPath(root, "stale-active")).mode & 0o777).toBe(0o600);
  });

  test("an ended instance's new ping survives name reuse and its normal same-instance reopen", () => {
    const root = fixture();
    session(root, "original-instance", "Maya");
    const route = resolveLiveEventLedgerRouteV3(root);
    const state = readHookProducerStateV3(root, "codex", "original-instance");
    if (route.state !== "v3" || !state) throw new Error("missing fixture authority");
    expect(
      recordApprovedSessionEndV3({
        coordRoot: root,
        mode: route.mode,
        instance_id: state.instance_id,
        generation_id: state.generation_id,
        build_id: route.build_id,
        platform: "linux",
        reason: "approved_explicit_end",
        outcome: "succeeded",
        coordination_finalized: true,
      }).state,
    ).toBe("recorded");
    const receipt = send(root, "original-instance", "ORIGINAL_INSTANCE_ONLY");
    expect(receipt.state).toBe("queued");
    session(root, "new-namesake", "Maya", later.toISOString());
    expect(
      renderPromptContext({
        coordRoot: root,
        instanceId: "new-namesake",
        sessionId: "new-namesake",
        agentName: "Maya",
      }),
    ).not.toContain("ORIGINAL_INSTANCE_ONLY");
    expect(peerInbox(root).pending("new-namesake")).toEqual([]);
    expect(
      reopenLiveCoordinationGenerationV3({
        coordRoot: root,
        owner: "original-instance",
        nativeSessionId: "original-instance",
      }).state,
    ).toBe("reopened");
    expect(
      renderPromptContext({
        coordRoot: root,
        instanceId: "original-instance",
        sessionId: "original-instance",
        agentName: "Maya",
      }),
    ).toContain("ORIGINAL_INSTANCE_ONLY");
    expect(peerInbox(root).pending("original-instance")[0]?.message_id).toBe(receipt.message_id);
  });

  test("pending messages survive beyond seven days and terminal diagnostic grace is explicit", () => {
    const root = fixture();
    session(root, "retained-instance", "Maya");
    send(root, "retained-instance", "retain me");
    const service = peerInbox(root);
    const created = Date.parse(service.pending("retained-instance")[0]!.created_at);
    for (const lifecycle of ["resumable", "terminal"] as const) {
      expect(
        planInboxCompaction({
          recipient_instance_id: "retained-instance",
          records: service.records("retained-instance"),
          lifecycle,
          terminal_at: new Date(created).toISOString(),
          now: new Date(created + 8 * DAY),
          limits: PEER_INBOX_LIMITS,
        }),
      ).toMatchObject({ action: "none", protected_pending_count: 1 });
    }
    const before = readFileSync(inboxPath(root, "retained-instance"));
    expect(service.pending("retained-instance")).toHaveLength(1);
    expect(readFileSync(inboxPath(root, "retained-instance"))).toEqual(before);
    service.acknowledgeSurface(
      "retained-instance",
      service.pending("retained-instance").map(({ message_id }) => message_id),
    );
    const surfaced = service.records("retained-instance");
    expect(PEER_INBOX_LIMITS.terminal_grace_ms).toBe(7 * DAY);
    expect(
      planInboxCompaction({
        recipient_instance_id: "retained-instance",
        records: surfaced,
        lifecycle: "terminal",
        terminal_at: new Date(created).toISOString(),
        now: new Date(created + DAY),
        limits: PEER_INBOX_LIMITS,
      }),
    ).toMatchObject({ action: "none", reason_code: "terminal_grace" });
  });

  test("a polling watcher sees back-to-back durable appends while messages stay pending", async () => {
    const root = fixture();
    session(root, "watched-instance", "Maya");
    const service = peerInbox(root);
    const controller = new AbortController();
    const watcher = watchInbox(service, "watched-instance", {
      signal: controller.signal,
      poll_ms: 1,
    });
    const first = send(root, "watched-instance", "first append");
    const second = send(root, "watched-instance", "second append");
    try {
      expect((await watcher.next()).value?.message_id).toBe(first.message_id);
      expect((await watcher.next()).value?.message_id).toBe(second.message_id);
      expect(service.pending("watched-instance")).toHaveLength(2);
    } finally {
      controller.abort();
      await watcher.return(undefined);
    }
  });

  test("concurrent sender processes append two complete records to one exact instance", async () => {
    const root = fixture();
    const moduleUrl = pathToFileURL(join(import.meta.dir, "../inbox/peer-messages.ts")).href;
    const children = ["sender-one", "sender-two"].map((sender) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { peerInbox } from ${JSON.stringify(moduleUrl)}; peerInbox(process.argv[1]).send({sender_instance_id:process.argv[2],sender_display_name:process.argv[2],recipient_instance_id:"concurrent-instance",recipient_display_name:"Maya",body:process.argv[2]});`,
          root,
          sender,
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );
    for (const child of children)
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    const records = peerInbox(root).pending("concurrent-instance");
    expect(records.map(({ body }) => body).sort()).toEqual(["sender-one", "sender-two"]);
    expect(new Set(records.map(({ message_id }) => message_id)).size).toBe(2);
  });
});
