import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarneryInboxLimits } from "./contract.ts";
import { planInboxCompaction } from "./lifecycle.ts";
import { HarneryInboxService, inboxPath, type HarneryInboxSendInput } from "./service.ts";
import { watchInbox } from "./watcher.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("coordination inbox", () => {
  test("operator null and actual agent IDs survive durable read, replay and acknowledgement", async () => {
    const root = fixture();
    const service = new HarneryInboxService({ coord_root: root, limits: limits() });
    const operator = service.send({ ...message("operator feedback"), sender_instance_id: null, sender_display_name: "Operator" });
    const agent = service.send(message("agent feedback"));
    const replay = new HarneryInboxService({ coord_root: root, limits: limits() });
    expect(replay.records("recipient")).toMatchObject([
      { message_id: operator.message_id, sender_instance_id: null },
      { message_id: agent.message_id, sender_instance_id: "sender" },
    ]);
    expect(replay.status("recipient").pending_count).toBe(2);
    const emitted: (string | null)[] = [];
    await replay.surface("recipient", (records) => { emitted.push(...records.map(({ sender_instance_id }) => sender_instance_id)); });
    expect(emitted).toEqual([null, "sender"]);
    expect(service.pending("recipient")).toEqual([]);
  });

  test("the sender field is required and only null represents an operator", () => {
    const root = fixture();
    const service = new HarneryInboxService({ coord_root: root, limits: limits() });
    for (const invalid of [undefined, 42, "", "../sender"]) {
      expect(() => service.send({ ...message("invalid actor"), sender_instance_id: invalid } as HarneryInboxSendInput)).toThrow("invalid sender instance id");
    }
    expect(service.pending("recipient")).toEqual([]);
    service.send(message("valid actor"));
    const [record] = service.records("recipient");
    writeFileSync(inboxPath(root, "recipient"), JSON.stringify({ ...record, sender_instance_id: undefined }) + "\n");
    expect(() => service.records("recipient")).toThrow("invalid sender instance id");
    expect(() => service.pending("recipient")).toThrow("invalid sender instance id");
  });

  test("rejects capacity before append and preserves pending history", () => {
    const service = inbox({ max_pending_count: 2 });
    service.send(message("one"));
    service.send(message("two"));
    expect(() => service.send(message("three"))).toThrow("pending_count_limit");
    expect(service.pending("recipient").map(({ body }) => body)).toEqual(["one", "two"]);
    expect(service.status("recipient")).toMatchObject({
      pending_count: 2,
      pressure: "exhausted",
    });
  });

  test("surfaces oldest fitting records and a crash repeats without dropping", async () => {
    const service = inbox();
    service.send(message("one"));
    service.send(message("two"));
    await expect(
      service.surface("recipient", () => {
        throw new Error("prompt crash");
      }),
    ).rejects.toThrow("prompt crash");
    expect(service.pending("recipient")).toHaveLength(2);
    const emitted: string[] = [];
    const result = await service.surface(
      "recipient",
      (records) => {
        emitted.push(...records.map(({ body }) => body));
      },
      { max_count: 1, max_bytes: 100, max_tokens: 100 },
    );
    expect(emitted).toEqual(["one"]);
    expect(result).toMatchObject({
      remaining_pending_count: 1,
      repeated_after_crash_possible: true,
    });
  });

  test("plans compaction only after surfaced and terminal grace", async () => {
    let clock = new Date("2026-08-29T12:00:00.000Z");
    const service = inbox({}, () => clock);
    service.send(message("one"));
    await service.surface("recipient", () => {});
    clock = new Date("2026-08-29T12:00:02.000Z");
    const records = service.records("recipient");
    expect(
      planInboxCompaction({
        recipient_instance_id: "recipient",
        records,
        lifecycle: "active",
        now: clock,
        limits: limits(),
      }),
    ).toMatchObject({ action: "compact-surfaced", remove_record_count: 2, dry_run: true });
    expect(
      planInboxCompaction({
        recipient_instance_id: "recipient",
        records,
        lifecycle: "terminal",
        terminal_at: "2026-08-29T12:00:01.500Z",
        now: clock,
        limits: limits(),
      }),
    ).toMatchObject({ action: "none", reason_code: "terminal_grace" });
  });

  test("watcher recovers when the recipient history appears later", async () => {
    const service = inbox();
    const controller = new AbortController();
    const watcher = watchInbox(service, "recipient", { signal: controller.signal, poll_ms: 5 });
    const next = watcher.next();
    await Bun.sleep(10);
    service.send(message("later"));
    const observed = await next;
    controller.abort();
    expect(observed.value?.body).toBe("later");
  });

  test("prepared IDs cannot acknowledge an unseen concurrent append", () => {
    const service = inbox();
    service.send(message("prepared"));
    const selected = service.prepareSurface("recipient");
    service.send(message("newer"));
    service.acknowledgeSurface("recipient", selected.map(({ message_id }) => message_id));
    expect(service.pending("recipient").map(({ body }) => body)).toEqual(["newer"]);
    service.acknowledgeSurface("recipient", selected.map(({ message_id }) => message_id));
    expect(service.records("recipient").filter(({ kind }) => kind === "surfaced")).toHaveLength(1);
  });
});

function inbox(overrides: Partial<HarneryInboxLimits> = {}, now?: () => Date) {
  return new HarneryInboxService({
    coord_root: fixture(),
    limits: limits(overrides),
    now,
    id: (() => {
      let sequence = 0;
      return () => String(++sequence);
    })(),
  });
}

function limits(overrides: Partial<HarneryInboxLimits> = {}): HarneryInboxLimits {
  return {
    max_message_body_bytes: 256,
    max_pending_count: 10,
    max_pending_bytes: 1_024,
    max_history_bytes: 16_384,
    max_history_records: 100,
    warning_pressure_ratio: 0.8,
    max_surface_count: 4,
    max_surface_bytes: 512,
    max_surface_tokens: 128,
    surfaced_grace_ms: 1_000,
    terminal_grace_ms: 5_000,
    ...overrides,
  };
}

function message(body: string) {
  return {
    sender_instance_id: "sender",
    sender_display_name: "Sender",
    recipient_instance_id: "recipient",
    recipient_display_name: "Recipient",
    body,
  };
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-inbox-"));
  roots.push(root);
  return root;
}
