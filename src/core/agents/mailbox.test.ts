import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bareAgentName,
  drainMailbox,
  formatMailboxDelivery,
  isAddressableName,
  MAX_BODY_BYTES,
  MAX_PENDING,
  MailboxCapacityError,
  mailboxPath,
  peekMailbox,
  queueMailboxMessage,
  suggestNames,
} from "./mailbox.ts";

let root: string;

function queue(to: string, body: string, journaled = false) {
  return queueMailboxMessage({
    coordRoot: root,
    toName: to,
    fromName: "Talia",
    fromInstanceId: "instance-talia",
    body,
    journaled,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnery-mailbox-"));
  mkdirSync(join(root, ".harnery"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("bareAgentName", () => {
  test("strips the agent- prefix in any casing", () => {
    expect(bareAgentName("agent-Maya")).toBe("Maya");
    expect(bareAgentName("AGENT-Maya")).toBe("Maya");
    expect(bareAgentName("  Maya  ")).toBe("Maya");
  });
});

describe("queue and peek", () => {
  test("a message survives with no live recipient", () => {
    const result = queue("Maya", "pack efficiency notes are on disk");
    expect(result.pending).toBe(1);
    expect(existsSync(mailboxPath(root, "Maya"))).toBe(true);

    const pending = peekMailbox(root, "Maya");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.body).toBe("pack efficiency notes are on disk");
    expect(pending[0]!.from_name).toBe("Talia");
    expect(pending[0]!.journaled).toBe(false);
  });

  test("addressing is case-insensitive and prefix-insensitive", () => {
    queue("Maya", "first");
    queue("agent-maya", "second");
    expect(peekMailbox(root, "MAYA")).toHaveLength(2);
  });

  test("peek on an empty mailbox returns nothing rather than throwing", () => {
    expect(peekMailbox(root, "Nobody")).toEqual([]);
  });

  test("an oversized body is refused with an actionable error", () => {
    const body = "x".repeat(MAX_BODY_BYTES + 1);
    expect(() => queue("Maya", body)).toThrow(MailboxCapacityError);
    try {
      queue("Maya", body);
    } catch (error) {
      expect((error as MailboxCapacityError).reason_code).toBe("body_limit");
      expect((error as Error).message).toContain("managed artifact");
    }
  });

  test("a full queue is refused instead of growing without bound", () => {
    for (let i = 0; i < MAX_PENDING; i++) queue("Maya", `note ${i}`);
    expect(() => queue("Maya", "one too many")).toThrow(MailboxCapacityError);
  });

  test("a name that could escape the mailbox directory is rejected", () => {
    expect(() => queue("../../etc/passwd", "nope")).toThrow(/invalid agent name/);
  });
});

describe("drain", () => {
  test("returns pending messages and empties the queue", () => {
    queue("Maya", "first");
    queue("Maya", "second");

    const delivered = drainMailbox(root, "Maya");
    expect(delivered.map((m) => m.body)).toEqual(["first", "second"]);
    expect(peekMailbox(root, "Maya")).toEqual([]);
  });

  test("delivers exactly once across repeated drains", () => {
    queue("Maya", "only once");
    expect(drainMailbox(root, "Maya")).toHaveLength(1);
    expect(drainMailbox(root, "Maya")).toHaveLength(0);
  });

  test("keeps an audit copy of what it delivered", () => {
    queue("Maya", "audited");
    drainMailbox(root, "Maya");
    const archive = join(root, ".harnery", "mailbox", "delivered", "maya.jsonl");
    expect(existsSync(archive)).toBe(true);
    const record = JSON.parse(readFileSync(archive, "utf8").trim());
    expect(record.body).toBe("audited");
    expect(record.delivered_at).toBeTruthy();
  });

  test("a message queued after a drain is still delivered", () => {
    queue("Maya", "before");
    drainMailbox(root, "Maya");
    queue("Maya", "after");
    expect(drainMailbox(root, "Maya").map((m) => m.body)).toEqual(["after"]);
  });

  test("a torn line does not lose the rest of the mailbox", () => {
    queue("Maya", "good one");
    const path = mailboxPath(root, "Maya");
    writeFileSync(path, `${readFileSync(path, "utf8")}{not json\n`);
    expect(drainMailbox(root, "Maya").map((m) => m.body)).toEqual(["good one"]);
  });

  test("a claim file abandoned by a crashed reader is re-queued", () => {
    queue("Maya", "stranded");
    const path = mailboxPath(root, "Maya");
    const stale = `${path}.claim-999-1`;
    writeFileSync(stale, readFileSync(path, "utf8"));
    rmSync(path);
    // Backdate past the five-minute sweep threshold.
    const old = new Date(Date.now() - 10 * 60_000);
    require("node:fs").utimesSync(stale, old, old);

    // A drain on any name runs the sweep; the message returns to its queue.
    drainMailbox(root, "Someone");
    expect(peekMailbox(root, "Maya").map((m) => m.body)).toEqual(["stranded"]);
  });
});

describe("isAddressableName", () => {
  test("accepts a name from the built-in pool", () => {
    expect(isAddressableName(root, "Maya")).toBe(true);
    expect(isAddressableName(root, "agent-maya")).toBe(true);
  });

  test("rejects a name no agent has ever held", () => {
    expect(isAddressableName(root, "Zzzquux")).toBe(false);
    expect(isAddressableName(root, "")).toBe(false);
  });

  test("accepts a name present only in the identity registry", () => {
    const dir = join(root, ".harnery", "identities");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "11111111-1111-4111-8111-111111111111.json"),
      JSON.stringify({
        schema_version: 1,
        agent_id: "11111111-1111-4111-8111-111111111111",
        name: "Zzzquux",
        aliases: [],
        created_at: "2026-01-01T00:00:00Z",
      }),
    );
    expect(isAddressableName(root, "Zzzquux")).toBe(true);
  });
});

describe("suggestNames", () => {
  test("offers a near miss for a typo", () => {
    expect(suggestNames(root, "Mayaa")).toContain("Maya");
  });
});

describe("formatMailboxDelivery", () => {
  test("renders nothing for an empty batch", () => {
    expect(formatMailboxDelivery(root, [])).toBe("");
  });

  test("names the sender, the body, and how to reply", () => {
    queue("Maya", "notes are at docs/foo.md");
    const text = formatMailboxDelivery(root, drainMailbox(root, "Maya"));
    expect(text).toContain("agent-Talia");
    expect(text).toContain("notes are at docs/foo.md");
    expect(text).toContain("agents ping Talia");
  });

  test("counts a multi-message batch in its header", () => {
    queue("Maya", "one");
    queue("Maya", "two");
    expect(formatMailboxDelivery(root, drainMailbox(root, "Maya"))).toContain("2 messages");
  });
});

describe("adapter delivery gating", () => {
  test("an adapter that cannot receive prompt context does not consume messages", async () => {
    const { renderPromptContext } = await import("./render/prompt-context.ts");
    queue("Maya", "must survive a cursor prompt");

    // Cursor's prompt hook cannot inject context, so the renderer must leave
    // the queue intact for SessionStart rather than spending it on output that
    // is discarded before the model ever sees it.
    renderPromptContext({
      coordRoot: root,
      instanceId: "instance-maya",
      sessionId: "instance-maya",
      agentName: "Maya",
      adapter: "cursor",
    });
    expect(peekMailbox(root, "Maya").map((m) => m.body)).toEqual(["must survive a cursor prompt"]);
  });

  test("an adapter that can receive prompt context delivers and empties the queue", async () => {
    const { renderPromptContext } = await import("./render/prompt-context.ts");
    queue("Maya", "delivered on codex");

    const text = renderPromptContext({
      coordRoot: root,
      instanceId: "instance-maya",
      sessionId: "instance-maya",
      agentName: "Maya",
      adapter: "codex",
    });
    expect(text).toContain("delivered on codex");
    expect(peekMailbox(root, "Maya")).toEqual([]);
  });
});
