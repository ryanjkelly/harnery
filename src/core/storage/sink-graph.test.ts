import { describe, expect, test } from "bun:test";
import {
  type HarnerySink,
  HarnerySinkDeliveryError,
  HarnerySinkGraph,
  HarnerySinkGraphError,
} from "./sink-graph.ts";

describe("immutable sink graph", () => {
  test("delivers valid primary fan-out once and freezes construction state", async () => {
    const observed: string[] = [];
    const graph = new HarnerySinkGraph(
      [sink("root", observed), sink("file", observed), sink("exporter", observed)],
      [
        { from: "root", to: "file", kind: "primary" },
        { from: "root", to: "exporter", kind: "primary" },
      ],
    );
    const result = await graph.deliver("root", {
      origin: "structured-log",
      payload: { event: "canary" },
    });
    expect(observed).toEqual(["root:entry", "file:primary", "exporter:primary"]);
    expect(result).toMatchObject({ attempted: 3, truncated: false, failures: [] });
    expect(Object.isFrozen(graph)).toBeTrue();
    expect(Object.isFrozen(graph.sinks)).toBeTrue();
    expect(Object.isFrozen(graph.edges)).toBeTrue();
  });

  test("rejects self-edges, cycles, CLI capture, and captured-stream loops", async () => {
    expect(
      () =>
        new HarnerySinkGraph([sink("one", [])], [{ from: "one", to: "one", kind: "diagnostic" }]),
    ).toThrow(HarnerySinkGraphError);
    expect(
      () =>
        new HarnerySinkGraph(
          [sink("one", []), sink("two", [])],
          [
            { from: "one", to: "two", kind: "primary" },
            { from: "two", to: "one", kind: "fallback" },
          ],
        ),
    ).toThrow("sink graph cycle");
    expect(
      () =>
        new HarnerySinkGraph(
          [{ ...sink("capture", []), captures: { origin: "cli-emission" } }],
          [],
        ),
    ).toThrow("cannot capture CLI emission");
    expect(
      () =>
        new HarnerySinkGraph(
          [
            { ...sink("stderr", []), emits_stream: "stderr" },
            {
              ...sink("capture", []),
              captures: { origin: "stderr", origin_sink_id: "stderr" },
            },
          ],
          [{ from: "capture", to: "stderr", kind: "primary" }],
        ),
    ).toThrow("routes back");
    const graph = new HarnerySinkGraph([sink("one", [])], []);
    await expect(
      graph.deliver("one", { origin: "cli-emission", payload: "human output" }),
    ).rejects.toThrow("CLI emission is not a structured sink record");
  });

  test("isolates fallback and diagnostic failures from recursive routing", async () => {
    const observed: string[] = [];
    const graph = new HarnerySinkGraph(
      [
        sink("root", observed),
        failingSink("primary", observed),
        sink("diagnostic", observed),
        failingSink("fallback", observed),
        sink("recursive", observed),
      ],
      [
        { from: "root", to: "primary", kind: "primary" },
        { from: "primary", to: "diagnostic", kind: "diagnostic" },
        { from: "primary", to: "fallback", kind: "fallback" },
        { from: "fallback", to: "recursive", kind: "diagnostic" },
      ],
    );
    const result = await graph.deliver("root", {
      origin: "structured-log",
      payload: { event: "failure" },
    });
    expect(observed).toEqual([
      "root:entry",
      "primary:primary",
      "diagnostic:diagnostic",
      "fallback:fallback",
    ]);
    expect(result.failures.map(({ sink_id }) => sink_id)).toEqual(["primary", "fallback"]);
    expect(
      result.failures.every(({ error }) => error instanceof HarnerySinkDeliveryError),
    ).toBeTrue();
    expect(observed).not.toContain("recursive:diagnostic");
  });

  test("bounds deliveries and returns a typed exhaustion failure", async () => {
    const observed: string[] = [];
    const graph = new HarnerySinkGraph(
      [sink("root", observed), sink("first", observed), sink("second", observed)],
      [
        { from: "root", to: "first", kind: "primary" },
        { from: "root", to: "second", kind: "primary" },
      ],
      { max_deliveries: 2 },
    );
    const result = await graph.deliver("root", {
      origin: "raw-process",
      payload: Buffer.from("bounded"),
    });
    expect(result).toMatchObject({ attempted: 2, delivered: ["root", "first"], truncated: true });
    expect(result.failures[0]).toMatchObject({
      code: "delivery_budget_exhausted",
      sink_id: "second",
      route: "primary",
    });
    expect(result.failures[0]?.error).toBeInstanceOf(HarnerySinkDeliveryError);
  });
});

function sink(id: string, observed: string[]): HarnerySink {
  return {
    id,
    deliver(delivery) {
      observed.push(`${id}:${delivery.route}`);
    },
  };
}

function failingSink(id: string, observed: string[]): HarnerySink {
  return {
    id,
    deliver(delivery) {
      observed.push(`${id}:${delivery.route}`);
      throw new Error(`${id} failed`);
    },
  };
}
