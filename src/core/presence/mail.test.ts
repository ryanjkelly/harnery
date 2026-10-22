import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEventLedgerV3 } from "../events/v3/bootstrap.ts";
import { sha256V3 } from "../events/v3/canonical.ts";
import { formatPeerInbox, peerInbox, sendPeerMessage } from "../inbox/peer-messages.ts";
import { MAIL_REF_PREFIX, PRESENCE_REF_PREFIX, writePresenceCommit } from "./git.ts";
import { fetchPresence } from "./index.ts";
import { importMail, MAIL_TTL_MS, mailStatus, publishMail, queueMail } from "./mail.ts";

/**
 * Cross-machine peer messages (ADR 0222) against real git: a bare origin and
 * two clones standing in for two machines, switched with HARNERY_MACHINE.
 */

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

let base: string;
let origin: string;
let cloneA: string;
let cloneB: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "harnery-mail-"));
  origin = join(base, "origin.git");
  cloneA = join(base, "a");
  cloneB = join(base, "b");
  spawnSync("git", ["init", "--bare", origin], { encoding: "utf8" });
  for (const clone of [cloneA, cloneB]) {
    spawnSync("git", ["init", clone], { encoding: "utf8" });
    git(clone, "remote", "add", "origin", origin);
    mkdirSync(join(clone, ".harnery"), { recursive: true });
    initializeEventLedgerV3({
      coordRoot: clone,
      harneryBuild: "mail-test",
      hostBuild: "host-test",
      configDigest: sha256V3("config"),
      approvalRecordId: "mail-test",
    });
  }
  savedEnv.HARNERY_MACHINE = process.env.HARNERY_MACHINE;
  savedEnv.HARNERY_PRESENCE = process.env.HARNERY_PRESENCE;
  process.env.HARNERY_PRESENCE = "1";
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
});

function on(machine: "machine-a" | "machine-b"): string {
  process.env.HARNERY_MACHINE = machine;
  return machine === "machine-a" ? cloneA : cloneB;
}

function sync(root: string): void {
  expect(fetchPresence(root, { force: true, sync: true }).status).toBe("fetched");
}

/** Make `agents` visible in `root` as live presence published by `machine`. */
function seedRemotePresence(
  root: string,
  machine: string,
  agents: Array<{ instance_id: string; name: string }>,
  publishedAt = new Date(),
): void {
  const blob = {
    v: 1,
    machine,
    published_at: publishedAt.toISOString(),
    agents: agents.map((a) => ({ ...a, activity: "working", task_state: "active" })),
  };
  const sha = writePresenceCommit(root, JSON.stringify(blob));
  git(root, "update-ref", `${PRESENCE_REF_PREFIX}${machine}`, sha!);
}

function queueAtoB(body = "your pages shipped"): string {
  on("machine-a");
  return queueMail(cloneA, {
    messageId: `msg_${Math.random().toString(16).slice(2)}`,
    toMachine: "machine-b",
    senderInstanceId: "sender-a",
    senderName: "Klara",
    recipientInstanceId: "recipient-b",
    recipientName: "Dexter",
    body,
    maxBodyBytes: 4_000,
  }).message_id;
}

describe("cross-machine mail", () => {
  test("a message reaches the other machine's inbox once, then both sides prune", () => {
    const id = queueAtoB();
    expect(publishMail(cloneA, { sync: true }).status).toBe("published");

    on("machine-b");
    sync(cloneB);
    expect(importMail(cloneB, peerInbox(cloneB), { publish: false }).received).toBe(1);
    // Re-importing the same ref never duplicates the inbox record.
    expect(importMail(cloneB, peerInbox(cloneB), { publish: false }).received).toBe(0);
    const pending = peerInbox(cloneB).pending("recipient-b");
    expect(pending.map((m) => m.message_id)).toEqual([id]);
    expect(pending[0]).toMatchObject({ sender_machine: "machine-a", body: "your pages shipped" });
    expect(formatPeerInbox(cloneB, pending)).toContain("from agent-Klara on machine-a");
    expect(publishMail(cloneB, { sync: true }).status).toBe("published");

    on("machine-a");
    sync(cloneA);
    expect(importMail(cloneA, peerInbox(cloneA), { publish: false }).delivered).toBe(1);
    expect(mailStatus(cloneA)).toMatchObject({ outbox: [], delivered: 1 });
    expect(publishMail(cloneA, { sync: true }).status).toBe("published");

    on("machine-b");
    sync(cloneB);
    expect(importMail(cloneB, peerInbox(cloneB), { publish: false }).released).toBe(1);
    expect(mailStatus(cloneB).acks).toBe(0);
    // Nothing left to carry on either side.
    expect(publishMail(cloneB, { sync: true }).status).toBe("published");
    on("machine-a");
    expect(publishMail(cloneA, { sync: true }).status).toBe("skipped");
  });

  test("ignores mail addressed to another machine or forged under another machine's ref", () => {
    queueAtoB();
    on("machine-a");
    publishMail(cloneA, { sync: true });
    // machine-c sees machine-a's ref but nothing in it is addressed to machine-c.
    process.env.HARNERY_MACHINE = "machine-c";
    sync(cloneB);
    expect(importMail(cloneB, peerInbox(cloneB), { publish: false }).received).toBe(0);

    // A blob whose envelopes claim another sender machine is ignored.
    on("machine-b");
    const forged = {
      v: 1,
      machine: "machine-z",
      published_at: new Date().toISOString(),
      outbox: [
        {
          schema: "harnery.mail-envelope/v1",
          message_id: "msg_forged",
          from_machine: "machine-a",
          to_machine: "machine-b",
          sender_instance_id: "x",
          sender_display_name: "X",
          recipient_instance_id: "recipient-b",
          recipient_display_name: "Dexter",
          created_at: new Date().toISOString(),
          body: "hi",
          body_bytes: 2,
        },
      ],
      acks: [],
    };
    git(
      cloneB,
      "update-ref",
      `${MAIL_REF_PREFIX}machine-z`,
      writePresenceCommit(cloneB, JSON.stringify(forged))!,
    );
    const result = importMail(cloneB, peerInbox(cloneB), { publish: false });
    expect(
      peerInbox(cloneB)
        .pending("recipient-b")
        .map((m) => m.message_id),
    ).not.toContain("msg_forged");
    expect(result.received).toBe(1);
  });

  test("an unacknowledged message expires after the TTL", () => {
    queueAtoB();
    on("machine-a");
    const later = new Date(Date.now() + MAIL_TTL_MS + 60_000);
    publishMail(cloneA, { sync: true, now: later });
    expect(mailStatus(cloneA)).toMatchObject({ outbox: [], expired: 1 });
  });

  test("ping resolves a name from another machine's presence and queues it there", () => {
    on("machine-a");
    seedRemotePresence(cloneA, "machine-b", [{ instance_id: "recipient-b", name: "Dexter" }]);
    const sent = sendPeerMessage({
      coordRoot: cloneA,
      target: { name: "Dexter" },
      senderInstanceId: "sender-a",
      senderName: "Klara",
      body: "deployed your commits",
    });
    expect(sent).toMatchObject({
      ok: true,
      state: "remote",
      published: true,
      target: { instance_id: "recipient-b", name: "Dexter", machine: "machine-b" },
    });

    on("machine-b");
    sync(cloneB);
    importMail(cloneB, peerInbox(cloneB), { publish: false });
    expect(peerInbox(cloneB).pending("recipient-b")[0]?.body).toBe("deployed your commits");
  });

  test("a reply finds the sender after its machine's presence goes quiet", () => {
    queueAtoB();
    on("machine-a");
    publishMail(cloneA, { sync: true });
    on("machine-b");
    sync(cloneB);
    importMail(cloneB, peerInbox(cloneB), { publish: false });
    // No presence ref for machine-a exists in cloneB; the mail log knows Klara.
    const reply = sendPeerMessage({
      coordRoot: cloneB,
      target: { name: "Klara", instanceId: "sender-a" },
      senderInstanceId: "recipient-b",
      senderName: "Dexter",
      body: "thanks",
    });
    expect(reply).toMatchObject({ ok: true, target: { machine: "machine-a" } });
  });

  test("the same name on two other machines is ambiguous, and unknown names still fail", () => {
    on("machine-a");
    seedRemotePresence(cloneA, "machine-b", [{ instance_id: "one", name: "Dexter" }]);
    seedRemotePresence(cloneA, "machine-c", [{ instance_id: "two", name: "Dexter" }]);
    const ambiguous = sendPeerMessage({
      coordRoot: cloneA,
      target: { name: "Dexter" },
      senderInstanceId: "sender-a",
      senderName: "Klara",
      body: "hello",
    });
    expect(ambiguous).toMatchObject({ ok: false, code: "ambiguous_peer" });
    const exact = sendPeerMessage({
      coordRoot: cloneA,
      target: { name: "Dexter", instanceId: "two" },
      senderInstanceId: "sender-a",
      senderName: "Klara",
      body: "hello",
    });
    expect(exact).toMatchObject({ ok: true, target: { machine: "machine-c" } });
    const unknown = sendPeerMessage({
      coordRoot: cloneA,
      target: { name: "Nobody" },
      senderInstanceId: "sender-a",
      senderName: "Klara",
      body: "hello",
    });
    expect(unknown).toMatchObject({ ok: false, code: "no_peer" });
  });

  test("--require-live refuses a recipient known only from stale presence", () => {
    on("machine-a");
    seedRemotePresence(
      cloneA,
      "machine-b",
      [{ instance_id: "recipient-b", name: "Dexter" }],
      new Date(Date.now() - 3_600_000),
    );
    const sent = sendPeerMessage({
      coordRoot: cloneA,
      target: { name: "Dexter", requireLive: true },
      senderInstanceId: "sender-a",
      senderName: "Klara",
      body: "hello",
    });
    expect(sent).toMatchObject({ ok: false, code: "not_live" });
  });
});
