import { expect, test } from "bun:test";
import {
  type AttentionMessage,
  type AttentionRouting,
  createAttentionClient,
} from "./attention-client";

const reply = (extra: Partial<AttentionRouting> = {}): AttentionRouting => ({
  eventKey: "event",
  recipientId: "client",
  generation: "gen",
  state: "selected",
  granted: false,
  engaged: false,
  serverNow: 1000,
  expiresAt: 7000,
  ...extra,
});
function fixture(transport: (message: AttentionMessage) => Promise<AttentionRouting>) {
  let time = 0;
  const grants: boolean[] = [],
    timers = new Map<number, { fn: () => void; delay: number }>();
  let stops = 0,
    acks = 0,
    nextTimer = 0;
  const client = createAttentionClient({
    clientId: "client",
    transport,
    now: () => time,
    schedule: (fn, delay) => {
      const id = ++nextTimer;
      timers.set(id, { fn, delay });
      return id;
    },
    cancel: (id) => {
      timers.delete(id as number);
    },
    onGrant: (grant) => grants.push(grant.engaged),
    onStop: () => {
      stops++;
    },
    onAcknowledged: () => {
      acks++;
    },
  });
  return {
    client,
    grants,
    timers,
    setTime: (now: number) => {
      time = now;
    },
    get stops() {
      return stops;
    },
    get acks() {
      return acks;
    },
  };
}
const snapshot = { eventKey: "event", visible: true, focused: false, interaction: 0 };

test("one generation starts once and lease renewal does not replay channels", async () => {
  const messages: AttentionMessage[] = [];
  const f = fixture(async (message) => {
    messages.push(message);
    return reply(
      message.operation === "claim"
        ? { state: "claimed", granted: true, engaged: true }
        : messages.length > 2
          ? { state: "claimed" }
          : {},
    );
  });
  await f.client.observe(snapshot);
  await f.client.observe(snapshot);
  expect(f.grants).toEqual([true]);
  expect(messages.filter((message) => message.operation === "claim")).toHaveLength(1);
  expect((messages.at(-1) as { holdingGeneration: string }).holdingGeneration).toBe("gen");
  f.client.dispose();
});
test("the full monotonic round trip reduces lease duration and expiry stops channels", async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture(async (message) => {
    if (message.operation === "claim") f.setTime(1000);
    return reply({
      state: message.operation === "claim" ? "claimed" : "selected",
      granted: message.operation === "claim",
    });
  });
  await f.client.observe(snapshot);
  expect([...f.timers.values()][0]?.delay).toBe(5000);
  [...f.timers.values()][0]!.fn();
  expect(f.stops).toBe(1);
  f.client.dispose();
});
test("expired delayed grant never starts channels", async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture(async (message) => {
    if (message.operation === "claim") f.setTime(7000);
    return reply({ state: message.operation === "claim" ? "claimed" : "selected", granted: true });
  });
  await f.client.observe(snapshot);
  expect(f.grants).toEqual([]);
  f.client.dispose();
});
test("old grant after event replacement is discarded", async () => {
  let release!: (value: AttentionRouting) => void;
  let claimStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    claimStarted = resolve;
  });
  const f = fixture(async (message) => {
    if (message.operation === "claim") {
      claimStarted();
      return new Promise((resolve) => {
        release = resolve;
      });
    }
    return reply({
      eventKey: message.eventKey,
      state: message.eventKey === "event" ? "selected" : "waiting",
    });
  });
  const pending = f.client.observe(snapshot);
  await started;
  void f.client.observe({ ...snapshot, eventKey: "new-event" });
  release(reply({ state: "claimed", granted: true }));
  await pending;
  expect(f.grants).toEqual([]);
  f.client.dispose();
});
test("disposal while claim is pending cannot start old channels", async () => {
  let release!: (value: AttentionRouting) => void;
  let claimStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    claimStarted = resolve;
  });
  const f = fixture(async (message) => {
    if (message.operation === "claim") {
      claimStarted();
      return new Promise((resolve) => {
        release = resolve;
      });
    }
    return reply();
  });
  const pending = f.client.observe(snapshot);
  await started;
  f.client.dispose();
  release(reply({ state: "claimed", granted: true }));
  await pending;
  expect(f.grants).toEqual([]);
});
test("acknowledgment is separate and fences an in-flight grant", async () => {
  let release!: (value: AttentionRouting) => void;
  let claimStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    claimStarted = resolve;
  });
  const messages: AttentionMessage[] = [];
  const f = fixture(async (message) => {
    messages.push(message);
    if (message.operation === "claim") {
      claimStarted();
      return new Promise((resolve) => {
        release = resolve;
      });
    }
    return reply();
  });
  const pending = f.client.observe(snapshot);
  await started;
  const ack = f.client.acknowledge();
  release(reply({ state: "claimed", granted: true }));
  await pending;
  await ack;
  expect(f.grants).toEqual([]);
  expect(messages.some((message) => message.operation === "acknowledge")).toBe(true);
  f.client.dispose();
});
test("transport failure never extends the existing lease", async () => {
  let failed = false;
  const f = fixture(async (message) => {
    if (failed) throw new Error("offline");
    return reply({
      state: message.operation === "claim" ? "claimed" : "selected",
      granted: message.operation === "claim",
    });
  });
  await f.client.observe(snapshot);
  const timer = [...f.timers.values()][0];
  failed = true;
  await f.client.observe(snapshot);
  expect([...f.timers.values()][0]).toBe(timer);
  timer!.fn();
  expect(f.stops).toBe(1);
  f.client.dispose();
});
test("server acknowledgment stops channels without another grant", async () => {
  let acknowledged = false;
  const f = fixture(async (message) =>
    reply({
      state: acknowledged ? "acknowledged" : message.operation === "claim" ? "claimed" : "selected",
      granted: !acknowledged && message.operation === "claim",
    }),
  );
  await f.client.observe(snapshot);
  acknowledged = true;
  await f.client.observe(snapshot);
  expect(f.grants).toHaveLength(1);
  expect(f.stops).toBe(1);
  expect(f.acks).toBe(1);
  f.client.dispose();
});

test("malformed routing responses never start or extend channels", async () => {
  for (const malformed of [
    { ...reply(), serverNow: "1000" },
    { ...reply(), granted: "true" },
    { ...reply(), expiresAt: Number.POSITIVE_INFINITY },
    { ...reply(), engaged: "false" },
  ]) {
    const f = fixture(
      async (message) =>
        (message.operation === "claim"
          ? { ...malformed, state: "claimed", granted: true }
          : malformed) as AttentionRouting,
    );
    await f.client.observe(snapshot);
    expect(f.grants).toEqual([]);
    expect(f.timers.size).toBe(0);
    f.client.dispose();
  }
});
