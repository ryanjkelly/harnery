import { describe, expect, test } from "bun:test";
import {
  type EventV3Fixture,
  eventV3Fixture,
  fixtureObject,
} from "../../../../tests/helpers/event-v3.ts";
import type { EventV3 } from "./contract.ts";
import { projectDelegationRollupV3, projectEconomicsV3 } from "./economics.ts";
import type { ReadLedgerV3Result } from "./reader.ts";

describe("event ledger V3 economics projection", () => {
  test("attributes tokens, timing, and configured model cost by turn and generation", () => {
    const session = eventV3Fixture("session.started", 1);
    const generationId = fixtureObject(session.scope).generation_id as string;
    const runtime = fixtureObject(fixtureObject(session.payload).runtime_attestation);
    runtime.model = observed({ provider: "openai", id: "gpt-fixture" });

    const first = eventV3Fixture("turn.completed", 2);
    setScope(first, generationId, `tid_${"a".repeat(64)}`);
    setEconomics(first, {
      input: 100,
      output: 50,
      cacheRead: 20,
      inference: 100,
      harness: 10,
    });
    const second = eventV3Fixture("turn.completed", 3);
    setScope(second, generationId, `tid_${"b".repeat(64)}`);
    setEconomics(second, { input: 200, output: 100, inference: 200, harness: 20 });

    const projection = projectEconomicsV3(readOf(session, first, second), {
      pricing: {
        "openai/gpt-fixture": {
          input_usd_per_million: 1,
          output_usd_per_million: 2,
          cache_read_usd_per_million: 0.5,
        },
      },
    });

    expect(projection.turns[0]).toMatchObject({
      model_key: "openai/gpt-fixture",
      usage_method: "native_payload",
      tokens: {
        state: "observed",
        value: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 20,
          cache_write_tokens: 0,
        },
      },
      inference_ms: { state: "observed", value_ms: 100 },
      harness_ms: { state: "observed", value_ms: 10 },
      cost: { state: "observed", usd: 0.00021, pricing_key: "openai/gpt-fixture" },
    });
    expect(projection.generations).toEqual([
      expect.objectContaining({
        generation_id: generationId,
        turn_count: 2,
        tokens: {
          state: "observed",
          value: {
            input_tokens: 300,
            output_tokens: 150,
            cache_read_tokens: 20,
            cache_write_tokens: 0,
          },
        },
        inference_ms: { state: "observed", value_ms: 300 },
        harness_ms: { state: "observed", value_ms: 30 },
        cost: { state: "observed", usd: 0.00061, pricing_key: "openai/gpt-fixture" },
      }),
    ]);
  });

  test("retains known lower bounds when usage or pricing is unavailable", () => {
    const first = eventV3Fixture("turn.completed", 1);
    const generationId = fixtureObject(first.scope).generation_id as string;
    setEconomics(first, { input: 10, output: 5, inference: 20, harness: 2 });
    const second = eventV3Fixture("turn.completed", 2);
    setScope(second, generationId, `tid_${"b".repeat(64)}`);
    const secondPayload = fixtureObject(second.payload);
    secondPayload.usage = { state: "unsupported", capability: "model_usage" };
    secondPayload.inference = { state: "unsupported", capability: "inference_timing" };
    secondPayload.harness = observed({ hook_time_ms: 3, hook_count: 1 });

    const generation = projectEconomicsV3(readOf(first, second)).generations[0]!;
    expect(generation.tokens).toEqual({
      state: "unknown",
      known: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
      reasons: ["unsupported"],
    });
    expect(generation.inference_ms).toEqual({
      state: "unknown",
      known_ms: 20,
      reasons: ["unsupported"],
    });
    expect(generation.harness_ms).toEqual({ state: "observed", value_ms: 5 });
    expect(generation.cost).toEqual({
      state: "unknown",
      known_usd: 0,
      reasons: ["model_unknown", "usage_unknown"],
    });
  });

  test("rolls economics through the delegation generation tree and reports cycles", () => {
    const rootId = "gen_00000000-0000-7000-8000-000000000101";
    const childId = "gen_00000000-0000-7000-8000-000000000102";
    const rootTurn = eventV3Fixture("turn.completed", 1);
    setScope(rootTurn, rootId, `tid_${"a".repeat(64)}`);
    setEconomics(rootTurn, { input: 10, output: 5, inference: 20, harness: 2 });
    const childTurn = eventV3Fixture("turn.completed", 2);
    setScope(childTurn, childId, `tid_${"b".repeat(64)}`);
    setEconomics(childTurn, { input: 20, output: 10, inference: 30, harness: 3 });
    const edge = eventV3Fixture("agent.completed", 3);
    setScope(edge, rootId);
    fixtureObject(edge.payload).child_generation_id = childId;
    const read = readOf(rootTurn, childTurn, edge);
    const economics = projectEconomicsV3(read);

    const rollup = projectDelegationRollupV3(read, economics, rootId);
    expect(rollup.generation_ids).toEqual([rootId, childId]);
    expect(rollup.tokens).toEqual({
      state: "observed",
      value: {
        input_tokens: 30,
        output_tokens: 15,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
    });
    expect(rollup.inference_ms).toEqual({ state: "observed", value_ms: 50 });
    expect(rollup.diagnostics).toEqual([]);

    const reverse = eventV3Fixture("agent.completed", 4);
    setScope(reverse, childId);
    fixtureObject(reverse.payload).child_generation_id = rootId;
    const cyclicRead = readOf(rootTurn, childTurn, edge, reverse);
    expect(
      projectDelegationRollupV3(cyclicRead, projectEconomicsV3(cyclicRead), rootId).diagnostics,
    ).toContainEqual({ code: "delegation_cycle", generation_id: rootId });
  });

  test("refuses to project an incomplete ledger read", () => {
    const read = readOf();
    read.complete = false;
    expect(() => projectEconomicsV3(read)).toThrow("complete V3 ledger read");
  });
});

function setEconomics(
  event: EventV3Fixture,
  values: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    inference: number;
    harness: number;
  },
): void {
  const payload = fixtureObject(event.payload);
  payload.usage = observed({
    input_tokens: values.input,
    output_tokens: values.output,
    ...(values.cacheRead !== undefined ? { cache_read_tokens: values.cacheRead } : {}),
    ...(values.cacheWrite !== undefined ? { cache_write_tokens: values.cacheWrite } : {}),
    method: "native_payload",
  });
  payload.inference = observed({ api_time_ms: values.inference, request_count: 1 });
  payload.harness = observed({ hook_time_ms: values.harness, hook_count: 1 });
}

function setScope(event: EventV3Fixture, generationId: string, turnId?: string): void {
  const scope = fixtureObject(event.scope);
  scope.generation_id = generationId;
  if (turnId !== undefined) scope.turn_id = turnId;
}

function observed(value: unknown) {
  return { state: "observed", value, attestation: "native", confidence: "exact" };
}

function readOf(...events: EventV3Fixture[]): ReadLedgerV3Result {
  return {
    events: events.map((event, index) => ({
      event: event as unknown as EventV3,
      position: { segment_ordinal: 1, byte_offset: index * 1000 },
    })),
    diagnostics: [],
    complete: true,
    genesis_id: "gex_fixture",
    active_schema_digest: "sha256:fixture",
    advances: [],
    bytes: 0,
  };
}
