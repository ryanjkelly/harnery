import { expect, test } from "bun:test";
import { awaitThumbnail, createThumbnailQueue } from "./thumbnail-queue";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("a long Office conversion cannot occupy the slot reserved for fast visible files", async () => {
  const queue = createThumbnailQueue<void>();
  const held = latch();
  const order: string[] = [];
  queue.submit("office-a", "background", "expensive", async () => {
    order.push("office-a");
    await held.promise;
  });
  queue.submit("office-b", "background", "expensive", async () => {
    order.push("office-b");
  });
  const text = queue.submit("text", "visible", "fast", async () => {
    order.push("text");
  })!;
  await text.promise;
  expect(order).toEqual(["office-a", "text"]);
  held.release();
  await queue.idle();
  expect(order).toEqual(["office-a", "text", "office-b"]);
});

test("visible requests promote queued background work and share its result", async () => {
  const queue = createThumbnailQueue<number>();
  const held = latch();
  const order: string[] = [];
  queue.submit("held", "background", "expensive", async () => {
    await held.promise;
    return 0;
  });
  queue.submit("older", "background", "expensive", async () => {
    order.push("older");
    return 1;
  });
  const original = queue.submit("selected", "background", "expensive", async () => {
    order.push("selected");
    return 2;
  })!;
  const promoted = queue.submit("selected", "visible", "expensive", async () => {
    throw new Error("duplicate");
  })!;
  expect(promoted.created).toBe(false);
  expect(promoted.promise).toBe(original.promise);
  held.release();
  expect(await promoted.promise).toBe(2);
  await queue.idle();
  expect(order).toEqual(["selected", "older"]);
});

test("background admission leaves room for visible jobs and failures release slots", async () => {
  const queue = createThumbnailQueue<void>();
  const held = latch();
  for (let i = 0; i < 8; i++)
    expect(
      queue.submit(`background-${i}`, "background", "expensive", () => held.promise),
    ).not.toBeNull();
  expect(queue.submit("excess", "background", "fast", async () => {})).toBeNull();
  const fail = queue.submit("fail", "visible", "fast", async () => {
    throw new Error("failed");
  })!;
  await expect(fail.promise).rejects.toThrow("failed");
  const visible = queue.submit("visible", "visible", "fast", async () => {})!;
  await visible.promise;
  held.release();
  await queue.idle();
  expect(queue.size).toBe(0);
});

test("brief waits return ready images immediately and abort without cancelling generation", async () => {
  expect(await awaitThumbnail(Promise.resolve("image"), 40, new AbortController().signal)).toBe(
    "image",
  );
  const held = latch();
  const controller = new AbortController();
  const waiting = awaitThumbnail(
    held.promise.then(() => "image"),
    1000,
    controller.signal,
  );
  controller.abort();
  expect(await waiting).toBeUndefined();
  held.release();
  expect(await awaitThumbnail(new Promise(() => {}), 5, controller.signal)).toBeUndefined();
});
