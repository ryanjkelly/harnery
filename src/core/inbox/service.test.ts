import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HarneryInboxLimits,
  HarneryInboxMessageConflictError,
  HarneryInboxMessageHistoryMissingError,
} from "./contract.ts";
import { planInboxCompaction } from "./lifecycle.ts";
import {
  type HarneryInboxSendInput,
  HarneryInboxService,
  inboxPath,
  stableInboxMessageId,
} from "./service.ts";
import { watchInbox } from "./watcher.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("coordination inbox", () => {
  test("replay refuses crash-before-append and pruned history, but recovers a lost receipt", async () => {
    const root = fixture();
    const service = new HarneryInboxService({ coord_root: root, limits: limits() });
    const input = {
      ...message("frozen crash body"),
      message_id: stableInboxMessageId("crash-operation", "recipient"),
    };
    // The caller's persisted attempt precedes dispatch, which may never append.
    writeFileSync(join(root, "dispatch-started"), input.message_id);
    const before = Bun.spawn([process.execPath, "--eval", "process.exit(17)"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await before.exited).toBe(17);
    expect(() => service.send({ ...input, replay_only: true })).toThrow(
      HarneryInboxMessageHistoryMissingError,
    );
    expect(service.records("recipient")).toEqual([]);
    expect(() => service.send({ ...message("body"), replay_only: true })).toThrow(
      "replay requires explicit message id",
    );
    expect(() => service.send({ ...input, replay_only: "true" as unknown as boolean })).toThrow(
      "invalid replay_only flag",
    );
    const source = new URL("./service.ts", import.meta.url).href;
    const code = `import { HarneryInboxService } from ${JSON.stringify(source)}; new HarneryInboxService({coord_root:${JSON.stringify(root)},limits:${JSON.stringify(limits())}}).send(${JSON.stringify(input)}); process.exit(17);`;
    const after = Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" });
    expect(await after.exited).toBe(17);
    expect(await new Response(after.stdout).text()).toBe("");
    expect(await new Response(after.stderr).text()).toBe("");
    const history = readFileSync(inboxPath(root, "recipient"), "utf8");
    expect(service.send({ ...input, replay_only: true }).state).toBe("duplicate");
    expect(readFileSync(inboxPath(root, "recipient"), "utf8")).toBe(history);
    expect(() => service.send({ ...input, body: "changed crash body", replay_only: true })).toThrow(
      HarneryInboxMessageConflictError,
    );
    writeFileSync(inboxPath(root, "recipient"), "");
    expect(() => service.send({ ...input, replay_only: true })).toThrow(
      HarneryInboxMessageHistoryMissingError,
    );
    expect(readFileSync(inboxPath(root, "recipient"), "utf8")).toBe("");
  });

  test("operation IDs are stable per recipient and reject malformed identities", () => {
    const id = stableInboxMessageId("operation-1", "recipient");
    expect(id).toBe("msg_op_dd262f0abc79da240e6ed58368ba5963eb6ff55a21f0546bd69b098a6951f9d4");
    expect(stableInboxMessageId("operation-1", "recipient")).toBe(id);
    expect(stableInboxMessageId("operation-1", "parent")).not.toBe(id);
    expect(stableInboxMessageId("operation-2", "recipient")).not.toBe(id);
    for (const value of ["", "../operation", "x".repeat(129), ["operation"], null]) {
      expect(() => stableInboxMessageId(value as string, "recipient")).toThrow(
        "invalid operation id",
      );
      expect(() => stableInboxMessageId("operation", value as string)).toThrow(
        "invalid recipient instance id",
      );
    }
  });

  test("retries preserve the first message even at capacity and after surfacing", () => {
    const root = fixture();
    const service = new HarneryInboxService({
      coord_root: root,
      limits: limits({ max_pending_count: 1 }),
    });
    const input = {
      ...message("frozen body"),
      message_id: stableInboxMessageId("operation", "recipient"),
    };
    expect(service.send(input).state).toBe("queued");
    const original = readFileSync(inboxPath(root, "recipient"), "utf8");
    const replay = new HarneryInboxService({
      coord_root: root,
      limits: limits({ max_pending_count: 1 }),
      now: () => new Date("2030-01-01T00:00:00Z"),
    });
    expect(replay.send(input)).toMatchObject({
      state: "duplicate",
      message_id: input.message_id,
      body_bytes: 11,
      synced: true,
    });
    expect(readFileSync(inboxPath(root, "recipient"), "utf8")).toBe(original);
    service.acknowledgeSurface("recipient", [input.message_id]);
    const surfaced = readFileSync(inboxPath(root, "recipient"), "utf8");
    expect(replay.send(input).state).toBe("duplicate");
    expect(replay.pending("recipient")).toEqual([]);
    expect(readFileSync(inboxPath(root, "recipient"), "utf8")).toBe(surfaced);
  });

  test("same identity refuses changed payload or sender without modifying history", () => {
    const root = fixture();
    const service = new HarneryInboxService({ coord_root: root, limits: limits() });
    const input = {
      ...message("frozen body"),
      message_id: stableInboxMessageId("operation", "recipient"),
    };
    service.send(input);
    const original = readFileSync(inboxPath(root, "recipient"), "utf8");
    for (const delta of [
      { body: "changed body" },
      { sender_instance_id: "other-sender" },
      { sender_instance_id: null },
      { sender_display_name: "Other" },
      { recipient_display_name: "Other" },
    ]) {
      let refusal: unknown;
      try {
        service.send({ ...input, ...delta });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(HarneryInboxMessageConflictError);
      expect(refusal).toMatchObject({
        reason_code: "message_identity_conflict",
        message_id: input.message_id,
      });
      expect(String(refusal)).not.toContain("frozen body");
      expect(readFileSync(inboxPath(root, "recipient"), "utf8")).toBe(original);
    }
    expect(() => service.send({ ...input, message_id: "../bad" })).toThrow("invalid message id");
  });

  test("received retries validate immutable payload and sender machine", () => {
    const service = inbox();
    service.send(message("source"));
    const record = service.records("recipient")[0];
    if (record.kind !== "message") throw new Error("expected message");
    const incoming = { ...record, message_id: "remote-id", sender_machine: "machine-a" };
    expect(service.receive(incoming)).toBe("received");
    expect(service.receive({ ...incoming, created_at: "2030-01-01T00:00:00Z" })).toBe("duplicate");
    for (const delta of [
      { body: "change" },
      { sender_machine: "machine-b" },
      { sender_instance_id: "other" },
    ]) {
      expect(() => service.receive({ ...incoming, ...delta })).toThrow(
        HarneryInboxMessageConflictError,
      );
    }
    expect(service.pending("recipient")).toHaveLength(2);
  });

  test("ordinary sends retain fresh UUIDs and the configured byte limit", () => {
    const service = new HarneryInboxService({
      coord_root: fixture(),
      limits: limits({ max_message_body_bytes: 4_000, max_pending_bytes: 10_000 }),
    });
    const first = service.send(message("same body"));
    const second = service.send(message("same body"));
    expect(first.message_id).toMatch(/^msg_[0-9a-f-]{36}$/);
    expect(second.message_id).not.toBe(first.message_id);
    expect(service.send(message("é".repeat(2_000))).body_bytes).toBe(4_000);
    expect(() => service.send(message("é".repeat(2_000) + "x"))).toThrow("message_body_limit");
  });

  test("concurrent process retries append one retained message", async () => {
    const root = fixture();
    const source = new URL("./service.ts", import.meta.url).href;
    const input = {
      ...message("concurrent frozen body"),
      message_id: stableInboxMessageId("concurrent-operation", "recipient"),
    };
    const code = `import { HarneryInboxService } from ${JSON.stringify(source)}; const service = new HarneryInboxService({coord_root:${JSON.stringify(root)},limits:${JSON.stringify(limits())}}); console.log(JSON.stringify(service.send(${JSON.stringify(input)})));`;
    const children = Array.from({ length: 2 }, () =>
      Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" }),
    );
    const results = await Promise.all(
      children.map(async (child) => ({
        exit: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      })),
    );
    expect(results.map(({ exit, stderr }) => ({ exit, stderr }))).toEqual([
      { exit: 0, stderr: "" },
      { exit: 0, stderr: "" },
    ]);
    expect(results.map(({ stdout }) => JSON.parse(stdout).state).sort()).toEqual([
      "duplicate",
      "queued",
    ]);
    const service = new HarneryInboxService({ coord_root: root, limits: limits() });
    expect(service.records("recipient")).toHaveLength(1);
  });

  test("operator null and actual agent IDs survive durable read, replay and acknowledgement", async () => {
    const root = fixture();
    const service = new HarneryInboxService({ coord_root: root, limits: limits() });
    const operator = service.send({
      ...message("operator feedback"),
      sender_instance_id: null,
      sender_display_name: "Operator",
    });
    const agent = service.send(message("agent feedback"));
    const replay = new HarneryInboxService({ coord_root: root, limits: limits() });
    expect(replay.records("recipient")).toMatchObject([
      { message_id: operator.message_id, sender_instance_id: null },
      { message_id: agent.message_id, sender_instance_id: "sender" },
    ]);
    expect(replay.status("recipient").pending_count).toBe(2);
    const emitted: (string | null)[] = [];
    await replay.surface("recipient", (records) => {
      emitted.push(...records.map(({ sender_instance_id }) => sender_instance_id));
    });
    expect(emitted).toEqual([null, "sender"]);
    expect(service.pending("recipient")).toEqual([]);
  });

  test("the sender field is required and only null represents an operator", () => {
    const root = fixture();
    const service = new HarneryInboxService({ coord_root: root, limits: limits() });
    for (const invalid of [undefined, 42, "", "../sender"]) {
      expect(() =>
        service.send({
          ...message("invalid actor"),
          sender_instance_id: invalid,
        } as HarneryInboxSendInput),
      ).toThrow("invalid sender instance id");
    }
    expect(service.pending("recipient")).toEqual([]);
    service.send(message("valid actor"));
    const [record] = service.records("recipient");
    writeFileSync(
      inboxPath(root, "recipient"),
      JSON.stringify({ ...record, sender_instance_id: undefined }) + "\n",
    );
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
    service.acknowledgeSurface(
      "recipient",
      selected.map(({ message_id }) => message_id),
    );
    expect(service.pending("recipient").map(({ body }) => body)).toEqual(["newer"]);
    service.acknowledgeSurface(
      "recipient",
      selected.map(({ message_id }) => message_id),
    );
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
