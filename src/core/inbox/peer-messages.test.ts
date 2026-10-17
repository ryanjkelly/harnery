import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPromptContext } from "../agents/render/prompt-context.ts";
import { renderSessionContext } from "../agents/render/session-context.ts";
import { acknowledgeEmittedPeerInbox, formatPeerInbox, peerInbox } from "./peer-messages.ts";
import { inboxPath } from "./service.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
