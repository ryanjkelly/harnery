import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../../tests/helpers/remove-dir.ts";
import { peerInbox } from "../../inbox/peer-messages.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnery-prompt-delivery-"));
  mkdirSync(join(root, ".harnery"), { recursive: true });
});

afterEach(() => {
  removeDir(root);
});

describe("prompt delivery", () => {
  function queueForInstance(body: string) {
    return peerInbox(root).send({
      sender_instance_id: "instance-talia",
      sender_display_name: "Talia",
      recipient_instance_id: "instance-maya",
      recipient_display_name: "Maya",
      body,
    });
  }

  test("Cursor prompt context delivers and empties the queue", async () => {
    const { renderPromptContext } = await import("./prompt-context.ts");
    const sent = queueForInstance("delivered on cursor");
    let prepared: readonly string[] = [];

    const text = renderPromptContext({
      coordRoot: root,
      instanceId: "instance-maya",
      sessionId: "instance-maya",
      onInboxPrepared: (ids) => {
        prepared = ids;
      },
    });
    expect(text).toContain("delivered on cursor");
    expect(prepared).toEqual([sent.message_id]);
    expect(peerInbox(root).pending("instance-maya")).toHaveLength(1);
    peerInbox(root).acknowledgeSurface("instance-maya", prepared);
    expect(peerInbox(root).pending("instance-maya")).toEqual([]);
  });

  test("an adapter that can receive prompt context delivers and empties the queue", async () => {
    const { renderPromptContext } = await import("./prompt-context.ts");
    const sent = queueForInstance("delivered on codex");
    let prepared: readonly string[] = [];

    const text = renderPromptContext({
      coordRoot: root,
      instanceId: "instance-maya",
      sessionId: "instance-maya",
      onInboxPrepared: (ids) => {
        prepared = ids;
      },
    });
    expect(text).toContain("delivered on codex");
    expect(prepared).toEqual([sent.message_id]);
    expect(peerInbox(root).pending("instance-maya")).toHaveLength(1);
    peerInbox(root).acknowledgeSurface("instance-maya", prepared);
    expect(peerInbox(root).pending("instance-maya")).toEqual([]);
  });
});
