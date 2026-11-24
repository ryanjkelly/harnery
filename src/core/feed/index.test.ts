import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { feedAgentName, mergeFeedItems, readLocalFeed } from "./index.ts";

let root: string;
const NOW = new Date("2026-11-23T20:00:00Z");
const RECIPIENT = "ddb660da-2958-4eb5-8782-ea623aea6a7f";
const AUTHOR = "16789ea4-65e3-4ebf-a8fb-94cba660ce41";

function message(id: string, at: string, body: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema: "harnery.inbox-record/v1",
    kind: "message",
    message_id: id,
    sender_instance_id: "sender-1",
    sender_display_name: "Tessa",
    recipient_instance_id: RECIPIENT,
    recipient_display_name: "Orion",
    created_at: at,
    body,
    body_bytes: body.length,
    ...extra,
  });
}

const JOURNAL = `# Journal: agent-Lorenzo
session_id: sid_1
machine: desk-1
started: 2026-11-23 1:00 PM -06:00
last_updated: 2026-11-23 1:30 PM -06:00

---

## 2026-11-23 1:30 PM -06:00 · done
Shipped the tools page.

## 2026-11-23 1:00 PM -06:00 · plan
Build the tools page.
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnery-feed-"));
  mkdirSync(join(root, ".harnery", "inbox"), { recursive: true });
  mkdirSync(join(root, ".harnery", "mail"), { recursive: true });
  mkdirSync(join(root, ".harnery", "journal", "archived"), { recursive: true });
});

afterEach(() => removeDir(root));

describe("readLocalFeed", () => {
  test("merges inbox messages, outbound mail, and journal entries newest first", () => {
    writeFileSync(
      join(root, ".harnery", "inbox", `${RECIPIENT}.jsonl`),
      [
        message("msg_a", "2026-11-23T18:00:00.000Z", "Track D is ready"),
        JSON.stringify({
          schema: "harnery.inbox-record/v1",
          kind: "surfaced",
          message_id: "msg_a",
        }),
        message("msg_parent", "2026-11-23T18:00:01.000Z", "[Parent copy for agent-Orion (x)]\nhi"),
        message("msg_remote", "2026-11-23T18:30:00.000Z", "From the other desk", {
          sender_machine: "desk-2",
        }),
        "{torn",
      ].join("\n"),
    );
    writeFileSync(
      join(root, ".harnery", "mail", "log.jsonl"),
      `${JSON.stringify({
        schema: "harnery.mail-log/v1",
        kind: "outbound",
        at: "2026-11-23T17:00:00.000Z",
        envelope: {
          schema: "harnery.mail-envelope/v1",
          message_id: "msg_out",
          from_machine: "desk-1",
          to_machine: "desk-2",
          sender_instance_id: "sender-1",
          sender_display_name: "Tessa",
          recipient_instance_id: "far-1",
          recipient_display_name: "Klara",
          created_at: "2026-11-23T17:00:00.000Z",
          body: "Over the relay",
          body_bytes: 14,
        },
      })}\n`,
    );
    writeFileSync(join(root, ".harnery", "journal", `${AUTHOR}.md`), JOURNAL);
    // The archive copy of the same journal collapses into the same items.
    writeFileSync(
      join(root, ".harnery", "journal", "archived", `${AUTHOR}-2026-11-23T19-00-00-000Z.md`),
      JOURNAL,
    );

    const { items, skipped_files } = readLocalFeed(root, { now: NOW, machine: "desk-1" });
    expect(skipped_files).toBe(0);
    expect(
      items.map((i) => (i.kind === "message" ? i.id : `${i.agent.name}:${i.category}`)),
    ).toEqual(["Lorenzo:done", "Lorenzo:plan", "msg_remote", "msg_a", "msg_out"]);
    const remote = items.find((i) => i.id === "msg_remote");
    expect(remote).toMatchObject({
      from: { name: "Tessa", machine: "desk-2" },
      to: { name: "Orion", machine: "desk-1", instance_id: RECIPIENT },
    });
    const out = items.find((i) => i.id === "msg_out");
    expect(out).toMatchObject({
      from: { machine: "desk-1" },
      to: { name: "Klara", machine: "desk-2" },
    });
    const done = items[0]!;
    expect(done).toMatchObject({
      kind: "journal",
      agent: { name: "Lorenzo", instance_id: AUTHOR, machine: "desk-1" },
      body: "Shipped the tools page.",
      at: "2026-11-23T19:30:00.000Z",
    });
  });

  test("the window and limit bound the result", () => {
    writeFileSync(
      join(root, ".harnery", "inbox", `${RECIPIENT}.jsonl`),
      [
        message("old", "2026-11-01T00:00:00.000Z", "too old"),
        message("new1", "2026-11-23T19:00:00.000Z", "one"),
        message("new2", "2026-11-23T19:10:00.000Z", "two"),
      ].join("\n"),
    );
    const r = readLocalFeed(root, { now: NOW, machine: "m", limit: 1 });
    expect(r.items.map((i) => i.id)).toEqual(["new2"]);
    expect(r.dropped).toBe(1);
  });

  test("a missing coordination directory yields an empty feed", () => {
    expect(readLocalFeed(join(root, "nope"), { now: NOW })).toEqual({
      items: [],
      skipped_files: 0,
      dropped: 0,
    });
  });
});

describe("helpers", () => {
  test("feedAgentName strips the display prefix", () => {
    expect(feedAgentName("agent-Hank")).toBe("Hank");
    expect(feedAgentName("Tessa")).toBe("Tessa");
    expect(feedAgentName("")).toBe("unknown");
  });

  test("mergeFeedItems prefers the untruncated copy of a duplicate", () => {
    const base = {
      kind: "message" as const,
      id: "m1",
      at: "2026-11-23T00:00:00Z",
      from: { name: "A", instance_id: null, machine: "x" },
      to: { name: "B", instance_id: null, machine: "y" },
    };
    const merged = mergeFeedItems(
      [{ ...base, body: "short…", body_truncated: true }],
      [{ ...base, body: "short and complete" }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.body).toBe("short and complete");
  });
});
