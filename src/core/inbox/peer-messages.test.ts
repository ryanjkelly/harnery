import { afterEach, expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reopenLiveCoordinationGenerationV3 } from "../agents/live-authority-v3.ts";
import { renderPromptContext } from "../agents/render/prompt-context.ts";
import { renderSessionContext } from "../agents/render/session-context.ts";
import * as parentReferences from "../agents/state/parent-reference.ts";
import { initializeEventLedgerV3 } from "../events/v3/bootstrap.ts";
import { sha256V3 } from "../events/v3/canonical.ts";
import { readCoordinationViewV3 } from "../events/v3/coordination-view.ts";
import { resolveLiveEventLedgerRouteV3 } from "../events/v3/live-routing.ts";
import {
  readHookProducerStateV3,
  recordApprovedSessionEndV3,
  recordHookSignalV3,
} from "../events/v3/producers/recorder.ts";
import {
  acknowledgeEmittedPeerInbox,
  formatPeerInbox,
  peerInbox,
  sendPeerMessage,
} from "./peer-messages.ts";
import { inboxPath } from "./service.ts";
import * as messageTargets from "./targets.ts";

const roots: string[] = [];
const parentSpies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of parentSpies.splice(0)) spy.mockRestore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function routingFixture() {
  const root = fixture();
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("routing"),
    approvalRecordId: "peer-routing-fixture",
  });
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("fixture requires V3");
  for (const id of ["child", "parent", "other-parent"]) {
    expect(
      recordHookSignalV3({
        coordRoot: root,
        mode: route.mode,
        signal: "session-start",
        payload: { session_id: id, raw: {} },
        adapter: "claude-code",
        instance_id: `inst_${id}`,
        producer_id: "prd_peer-routing",
        build_id: route.build_id,
        platform: "linux",
      }).state,
    ).toBe("recorded");
    appendFileSync(
      join(root, ".harnery/.name-history"),
      JSON.stringify({ instance_id: id, name: id, kind: "session", ts: new Date().toISOString() }) +
        "\n",
    );
  }
  const view = readCoordinationViewV3(root);
  const reference: parentReferences.AgentParentReference = {
    state: "verified",
    relationship: "delegated-child",
    parent_instance_id: "parent",
    parent_v3_instance_id: "inst_parent",
    parent_generation_id: view.instances.inst_parent!.generation_id,
    parent_session_id: view.instances.inst_parent!.session_id,
    parent_name: "parent",
    source: "v3-session-link",
    addressable: true,
  };
  const spy = spyOn(parentReferences, "resolveAgentParentReference").mockReturnValue(reference);
  parentSpies.push(spy);
  const input = {
    coordRoot: root,
    target: { instanceId: "child" },
    senderInstanceId: "sender",
    senderName: "Sender",
    body: "  exact original body\n",
    operationId: "operation-one",
  };
  return { root, input, spy, reference, route };
}

function fill(root: string, recipient: string) {
  for (let i = 0; i < 25; i++) send(root, `existing-${i}`, recipient);
}

function rotateChild(root: string) {
  const route = resolveLiveEventLedgerRouteV3(root);
  const previous = readHookProducerStateV3(root, "claude-code", "child")!;
  if (route.state !== "v3") throw new Error("fixture requires V3");
  expect(
    recordApprovedSessionEndV3({
      coordRoot: root,
      mode: route.mode,
      instance_id: previous.instance_id,
      generation_id: previous.generation_id,
      build_id: route.build_id,
      platform: "linux",
      reason: "approved_explicit_end",
      outcome: "succeeded",
      coordination_finalized: true,
    }).state,
  ).toBe("recorded");
  const reopened = reopenLiveCoordinationGenerationV3({
    coordRoot: root,
    owner: "child",
    nativeSessionId: "child",
  });
  expect(reopened.generation_id).not.toBe(previous.generation_id);
}

test("a real child generation rotation between frozen plan and send suppresses a new parent append", () => {
  const { root, input } = routingFixture();
  const resolve = messageTargets.resolveMessageTarget;
  let childResolutions = 0;
  const spy = spyOn(messageTargets, "resolveMessageTarget").mockImplementation(
    (coordRoot, target, options) => {
      if (target.instanceId === "child" && ++childResolutions === 2) rotateChild(root);
      return resolve(coordRoot, target, options);
    },
  );
  parentSpies.push(spy);
  expect(sendPeerMessage(input)).toMatchObject({
    ok: false,
    complete: false,
    child: { code: "generation_mismatch", failure_stage: "addressing" },
    parent_copy: { ok: false, code: "parent_copy_suppressed" },
  });
  expect(peerInbox(root).pending("child")).toHaveLength(0);
  expect(peerInbox(root).pending("parent")).toHaveLength(0);
});

test("replay preserves a recorded parent receipt after the child generation rotates", () => {
  const { root, input } = routingFixture();
  const first = sendPeerMessage(input);
  expect(first).toMatchObject({ ok: true, parent_copy: { ok: true } });
  rotateChild(root);
  expect(sendPeerMessage({ ...input, operationReplayOnly: true })).toEqual(first);
  expect(peerInbox(root).pending("child")).toHaveLength(1);
  expect(peerInbox(root).pending("parent")).toHaveLength(1);
});

test("one operation preserves child bytes, marks only the direct parent, and retains private receipts", () => {
  const { root, input, spy } = routingFixture();
  const result = sendPeerMessage(input);
  expect(result).toMatchObject({
    ok: true,
    complete: true,
    operation_id: "operation-one",
    child: { ok: true, target: { instance_id: "child" } },
    parent_copy: { ok: true, target: { instance_id: "parent" } },
  });
  expect(peerInbox(root).pending("child")[0]!.body).toBe(input.body);
  expect(peerInbox(root).pending("parent")[0]!.body).toBe(
    `[Parent copy for agent-child (child)]\n${input.body}`,
  );
  expect(peerInbox(root).pending("other-parent")).toHaveLength(0);
  expect(spy).toHaveBeenCalledTimes(1);
  const directory = join(root, ".harnery/peer-operations");
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(
    statSync(join(directory, readdirSync(directory).find((p) => p.endsWith(".jsonl"))!)).mode &
      0o777,
  ).toBe(0o600);
});

test("child capacity failure still delivers safe parent and cannot become overall success", () => {
  const { root, input } = routingFixture();
  fill(root, "child");
  expect(sendPeerMessage(input)).toMatchObject({
    ok: false,
    complete: false,
    child: { ok: false, code: "inbox_pending_count_limit" },
    parent_copy: { ok: true },
  });
  expect(peerInbox(root).pending("parent")).toHaveLength(1);
});

test("both capacity failures remain separate", () => {
  const { root, input } = routingFixture();
  fill(root, "child");
  fill(root, "parent");
  expect(sendPeerMessage(input)).toMatchObject({
    ok: false,
    complete: false,
    child: { ok: false },
    parent_copy: { ok: false, code: "inbox_pending_count_limit" },
  });
});

test("parent capacity failure preserves child success", () => {
  const { root, input } = routingFixture();
  fill(root, "parent");
  expect(sendPeerMessage(input)).toMatchObject({
    ok: true,
    complete: false,
    child: { ok: true },
    parent_copy: { ok: false },
  });
});

test("4000-byte child is unchanged while parent-copy overflow is explicit", () => {
  const { root, input } = routingFixture();
  input.body = "x".repeat(4000);
  expect(sendPeerMessage(input)).toMatchObject({
    ok: true,
    complete: false,
    parent_copy: { ok: false, code: "parent_copy_overflow" },
  });
  expect(peerInbox(root).pending("child")[0]!.body).toBe(input.body);
  expect(peerInbox(root).pending("parent")).toHaveLength(0);
});

test("conflict and unknown parent suppress only the copy with exact reasons", () => {
  const { root, input, spy } = routingFixture();
  for (const state of ["conflict", "unknown"] as const) {
    spy.mockReturnValue({ state, reason: `fixture-${state}` });
    expect(sendPeerMessage({ ...input, operationId: state })).toMatchObject({
      ok: true,
      parent_reference: { state },
      parent_copy: { state: "skipped", reason: `fixture-${state}` },
    });
  }
  expect(peerInbox(root).pending("parent")).toHaveLength(0);
});

test("unresolved child never discovers or delivers its parent", () => {
  const { root, input, spy } = routingFixture();
  expect(sendPeerMessage({ ...input, target: { instanceId: "missing" } })).toMatchObject({
    ok: false,
    code: "no_peer",
    parent_copy: { state: "skipped", reason: "original_target_unresolved" },
  });
  expect(spy).not.toHaveBeenCalled();
  expect(peerInbox(root).pending("parent")).toHaveLength(0);
});

test("an ambiguous caller dispatch cannot create a missing generic operation plan", () => {
  const { root, input, spy } = routingFixture();
  expect(sendPeerMessage({ ...input, operationReplayOnly: true })).toMatchObject({
    ok: false,
    code: "message_history_unknown",
    complete: false,
  });
  expect(spy).not.toHaveBeenCalled();
  expect(peerInbox(root).pending("child")).toHaveLength(0);
  expect(peerInbox(root).pending("parent")).toHaveLength(0);
  const first = sendPeerMessage(input);
  expect(sendPeerMessage({ ...input, operationReplayOnly: true })).toEqual(first);
});

test("same operation freezes recipients and rejects changed body or sender intent", () => {
  const { root, input, spy, reference } = routingFixture();
  const first = sendPeerMessage(input);
  spy.mockReturnValue({
    ...reference,
    parent_instance_id: "other-parent",
    parent_v3_instance_id: "inst_other-parent",
  });
  expect(sendPeerMessage(input)).toEqual(first);
  expect(spy).toHaveBeenCalledTimes(1);
  for (const changed of [
    { ...input, body: "new body" },
    { ...input, senderInstanceId: "different" },
    { ...input, target: { instanceId: "parent" } },
  ]) {
    expect(sendPeerMessage(changed)).toMatchObject({ ok: false, code: "operation_conflict" });
  }
  expect(peerInbox(root).pending("child")).toHaveLength(1);
  expect(peerInbox(root).pending("parent")).toHaveLength(1);
  expect(peerInbox(root).pending("other-parent")).toHaveLength(0);
});

test("missing operation results after append reconcile through transport dedupe, never new messages", () => {
  const { root, input } = routingFixture();
  sendPeerMessage(input);
  const dir = join(root, ".harnery/peer-operations");
  const path = join(dir, readdirSync(dir).find((p) => p.endsWith(".jsonl"))!);
  const starts = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => JSON.parse(line).kind !== "result");
  writeFileSync(path, `${starts.join("\n")}\n`); // Retain durable start markers, remove only result receipts.
  expect(sendPeerMessage(input)).toMatchObject({
    ok: true,
    complete: true,
    child: { state: "duplicate" },
    parent_copy: { state: "duplicate" },
  });
  expect(peerInbox(root).pending("child")).toHaveLength(1);
  expect(peerInbox(root).pending("parent")).toHaveLength(1);
});

test("an ambiguous started operation with pruned transport history stays unknown and never requeues", () => {
  const { root, input } = routingFixture();
  sendPeerMessage(input);
  const dir = join(root, ".harnery/peer-operations");
  const path = join(dir, readdirSync(dir).find((p) => p.endsWith(".jsonl"))!);
  const starts = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => JSON.parse(line).kind !== "result");
  writeFileSync(path, `${starts.join("\n")}\n`);
  writeFileSync(inboxPath(root, "child"), "");
  writeFileSync(inboxPath(root, "parent"), "");
  for (let i = 0; i < 2; i++) {
    expect(sendPeerMessage(input)).toMatchObject({
      ok: false,
      complete: false,
      child: { ok: false, code: "message_history_unknown" },
      parent_copy: { ok: false, code: "message_history_unknown" },
    });
  }
  expect(peerInbox(root).pending("child")).toHaveLength(0);
  expect(peerInbox(root).pending("parent")).toHaveLength(0);
  expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(3);
});

test("a malformed stored success receipt cannot claim delivery", () => {
  const { root, input } = routingFixture();
  sendPeerMessage(input);
  const dir = join(root, ".harnery/peer-operations");
  const path = join(dir, readdirSync(dir).find((p) => p.endsWith(".jsonl"))!);
  const records = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  records.find((r) => r.kind === "result" && r.recipient === "child").result = { ok: true };
  writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  expect(sendPeerMessage(input)).toMatchObject({
    ok: false,
    code: "operation_unavailable",
    complete: false,
  });
  expect(peerInbox(root).pending("child")).toHaveLength(1);
  expect(peerInbox(root).pending("parent")).toHaveLength(1);
});

test("an exact parent generation mismatch cannot deliver to its replacement", () => {
  const { root, input, spy, reference } = routingFixture();
  spy.mockReturnValue({ ...reference, parent_generation_id: "gen_different" });
  expect(sendPeerMessage(input)).toMatchObject({
    ok: true,
    complete: false,
    parent_copy: { ok: false, code: "generation_mismatch" },
  });
  expect(peerInbox(root).pending("parent")).toHaveLength(0);
});

test("ended exact parent queues normally but require-live returns a separate refusal", () => {
  const { root, input, route } = routingFixture();
  const state = readHookProducerStateV3(root, "claude-code", "parent")!;
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
  expect(sendPeerMessage(input)).toMatchObject({
    ok: true,
    parent_copy: { ok: true, state: "queued" },
  });
  expect(
    sendPeerMessage({
      ...input,
      operationId: "live-only",
      target: { ...input.target, requireLive: true },
    }),
  ).toMatchObject({ ok: true, complete: false, parent_copy: { ok: false, code: "not_live" } });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "harn-peer-inbox-"));
  roots.push(root);
  return root;
}
function send(root: string, body: string, recipient = "original-instance") {
  return peerInbox(root).send({
    sender_instance_id: "sender-instance",
    sender_display_name: "Sender",
    recipient_instance_id: recipient,
    recipient_display_name: "Maya",
    body,
  });
}

test("render preparation leaves the original instance pending and never delivers to a reused name", () => {
  const root = fixture();
  send(root, "feedback for the original task");
  let prepared: readonly string[] = [];
  const original = renderPromptContext({
    coordRoot: root,
    instanceId: "original-instance",
    sessionId: "original-instance",
    agentName: "Maya",
    onInboxPrepared: (ids) => {
      prepared = ids;
    },
  });
  expect(original).toContain("feedback for the original task");
  expect(prepared).toHaveLength(1);
  expect(peerInbox(root).pending("original-instance")).toHaveLength(1);
  const reused = renderSessionContext({
    coordRoot: root,
    instanceId: "later-instance",
    sessionId: "later-instance",
    agentName: "Maya",
  });
  expect(reused).not.toContain("feedback for the original task");
  expect(peerInbox(root).pending("original-instance")).toHaveLength(1);
  expect(existsSync(join(root, ".harnery/journal/original-instance.md"))).toBe(false);
});

test("an abandoned render repeats and acknowledgement consumes only the emitted batch", () => {
  const root = fixture();
  const first = send(root, "first");
  const inbox = peerInbox(root);
  const prepared = inbox.prepareSurface("original-instance");
  expect(inbox.prepareSurface("original-instance")).toEqual(prepared);
  const second = send(root, "arrived while output was flushing");
  inbox.acknowledgeSurface("original-instance", [first.message_id]);
  expect(inbox.pending("original-instance").map(({ message_id }) => message_id)).toEqual([
    second.message_id,
  ]);
  inbox.acknowledgeSurface("original-instance", [first.message_id]);
  expect(inbox.records("original-instance").filter(({ kind }) => kind === "surfaced")).toHaveLength(
    1,
  );
});

test("async output failure leaves the same message pending for prompt recovery", async () => {
  const root = fixture();
  send(root, "must survive failed output");
  const inbox = peerInbox(root);
  await expect(
    inbox.surface("original-instance", async () => {
      throw new Error("output failed");
    }),
  ).rejects.toThrow("output failed");
  expect(inbox.pending("original-instance")).toHaveLength(1);
  expect(inbox.records("original-instance").map(({ kind }) => kind)).toEqual(["message"]);
});

test("instance histories remain private and expose IDs and exact reply binding", () => {
  const root = fixture();
  send(root, "private task body");
  const path = inboxPath(root, "original-instance");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const rendered = formatPeerInbox(root, peerInbox(root).prepareSurface("original-instance"));
  expect(rendered).toContain("msg_");
  expect(rendered).toContain("--instance-id sender-instance");
  expect(rendered).toContain("private task body");
});

test("operator feedback has no invented agent or reply target, including mixed batches", () => {
  const root = fixture();
  peerInbox(root).send({
    sender_instance_id: null,
    sender_display_name: "Operator",
    recipient_instance_id: "original-instance",
    recipient_display_name: "Maya",
    body: "operator feedback",
  });
  const operatorOnly = formatPeerInbox(root, peerInbox(root).prepareSurface("original-instance"));
  expect(operatorOnly).toContain("from Operator (");
  expect(operatorOnly).toContain("operator feedback");
  expect(operatorOnly).not.toContain("agent-Operator");
  expect(operatorOnly).not.toContain("agents ping");
  expect(operatorOnly).not.toContain("--instance-id null");
  send(root, "agent feedback");
  const mixed = formatPeerInbox(root, peerInbox(root).prepareSurface("original-instance"));
  expect(mixed).toContain("from agent-Sender (");
  expect(mixed).toContain("--instance-id sender-instance");
  expect(mixed).not.toContain("--instance-id null");
});

test("failed native stdout flush cannot mark prepared context surfaced", async () => {
  const root = fixture();
  const sent = send(root, "retry after failed native output");
  const write = process.stdout.write;
  process.stdout.write = ((_value: unknown, callback: (error?: Error) => void) => {
    callback(new Error("native stdout failed"));
    return false;
  }) as typeof process.stdout.write;
  try {
    await expect(
      acknowledgeEmittedPeerInbox(root, "original-instance", [sent.message_id]),
    ).rejects.toThrow("native stdout failed");
  } finally {
    process.stdout.write = write;
  }
  expect(peerInbox(root).pending("original-instance")).toHaveLength(1);
  expect(
    peerInbox(root)
      .records("original-instance")
      .map(({ kind }) => kind),
  ).toEqual(["message"]);
});
