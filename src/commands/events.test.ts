import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EventV3Fixture,
  eventV3Fixture,
  fixtureObject,
} from "../../tests/helpers/event-v3.ts";
import type { EmitContext } from "../commander.ts";
import { createHarneryProgram } from "../commander.ts";
import { canonicalJsonV2 } from "../core/events/v2/canonical.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("events latency command", () => {
  test("registers read-only V3 latency views", () => {
    const command = createHarneryProgram().commands.find(
      (candidate) => candidate.name() === "events",
    );
    expect(command?.commands.map((candidate) => candidate.name())).toEqual(["latency"]);
    expect(command?.commands[0]?.options.map(({ long }) => long)).toEqual([
      "--root",
      "--candidate",
      "--by-tool",
      "--by-generation",
      "--json",
    ]);
  });

  test("snapshots turn, generation, and tool views from one candidate ledger", async () => {
    const root = fixtureLedger();

    const turn = captureEmit();
    await run(root, [], turn.emit);
    expect(turn.text().trimEnd().split("\n")).toMatchInlineSnapshot(`
      [
        "GENERATION                                TURN                                                                  WALL    TOOL   COMMAND  WAIT  INFERENCE  HARNESS  RESIDUAL  CONTEXT",
        "----------------------------------------  --------------------------------------------------------------------  ------  -----  -------  ----  ---------  -------  --------  -------",
        "gen_00000000-0000-7000-8000-000000000001  sid_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  1000ms  300ms  0ms      0ms   50ms       20ms     630ms     ?",
      ]
    `);

    const generation = captureEmit();
    await run(root, ["--by-generation"], generation.emit);
    expect(generation.text().trimEnd().split("\n")).toMatchInlineSnapshot(`
      [
        "GENERATION                                TURNS  WALL    TOOL   COMMAND  WAIT  INFERENCE  HARNESS  RESIDUAL",
        "----------------------------------------  -----  ------  -----  -------  ----  ---------  -------  --------",
        "gen_00000000-0000-7000-8000-000000000001  1      1000ms  300ms  0ms      0ms   50ms       20ms     630ms",
      ]
    `);

    const tool = captureEmit();
    await run(root, ["--by-tool"], tool.emit);
    expect(tool.text().trimEnd().split("\n")).toMatchInlineSnapshot(`
      [
        "NAMESPACE  TOOL  CALLS  INCLUSIVE  COVERAGE",
        "---------  ----  -----  ---------  --------",
        "functions  exec  1      300ms      complete",
      ]
      `);
  }, 15_000);

  test("JSON preserves unknown metrics instead of coercing them to zero", async () => {
    const root = fixtureLedger({ unknownToolDuration: true });
    const output = captureEmit();
    await run(root, ["--json"], output.emit);
    const parsed = JSON.parse(output.text()) as Record<string, unknown>;
    const latency = parsed.latency as { turns: Array<{ tool_ms: Record<string, unknown> }> };
    expect(latency.turns[0]?.tool_ms).toMatchObject({ state: "unknown", known_ms: 0 });
  });
});

async function run(root: string, options: string[], emit: EmitContext): Promise<void> {
  await createHarneryProgram({ emit }).parseAsync(
    ["events", "latency", "--root", root, "--candidate", ...options],
    { from: "user" },
  );
}

function fixtureLedger(options: { unknownToolDuration?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-events-cli-"));
  roots.push(root);
  const genesis = eventV3Fixture("ledger.genesis", 1);
  const session = eventV3Fixture("session.started", 2);
  const sessionScope = fixtureObject(session.scope);
  const runtimeAttestation = fixtureObject(fixtureObject(session.payload).runtime_attestation);
  runtimeAttestation.attestation_id = session.attestation_id;
  runtimeAttestation.generation_id = sessionScope.generation_id;
  runtimeAttestation.declared_by_event_id = session.event_id;
  const tool = terminal("tool.completed", 3, 300);
  fixtureObject(tool.payload).tool = { namespace: "functions", name: "exec" };
  const turn = terminal("turn.completed", 4, 1000);
  const turnPayload = fixtureObject(turn.payload);
  turnPayload.tool_call_count = observed(1);
  turnPayload.inference = observed({ api_time_ms: 50, request_count: 1 });
  turnPayload.harness = observed({ hook_time_ms: 20, hook_count: 2 });
  alignTurn(turn, tool);
  if (options.unknownToolDuration) {
    const unknown = { state: "unknown", reason: "terminal_timing_unavailable" };
    fixtureObject(tool.payload).duration_ms = unknown;
    fixtureObject(fixtureObject(tool.payload).span).duration_ms = structuredClone(unknown);
  }
  const ledgerRoot = join(root, ".harnery", "ledgers", "v3");
  mkdirSync(ledgerRoot, { recursive: true });
  writeFileSync(
    join(ledgerRoot, "active.ndjson"),
    [genesis, session, tool, turn].map((event) => `${canonicalJsonV2(event)}\n`).join(""),
    "utf8",
  );
  return root;
}

function terminal(
  eventType: "tool.completed" | "turn.completed",
  sequence: number,
  duration: number,
) {
  const event = eventV3Fixture(eventType, sequence);
  const payload = fixtureObject(event.payload);
  payload.duration_ms = observed(duration);
  const span = fixtureObject(payload.span);
  span.opened_at = "2026-08-18T14:00:00.000Z";
  span.duration_ms = observed(duration);
  return event;
}

function alignTurn(turn: EventV3Fixture, event: EventV3Fixture): void {
  const turnScope = fixtureObject(turn.scope);
  const eventScope = fixtureObject(event.scope);
  eventScope.generation_id = turnScope.generation_id;
  eventScope.turn_id = turnScope.turn_id;
}

function observed(value: unknown) {
  return { state: "observed", value, attestation: "native", confidence: "exact" };
}

function captureEmit(): { emit: EmitContext; text: () => string } {
  let buffer = "";
  const append = (value: unknown) => {
    buffer += typeof value === "string" ? value : `${JSON.stringify(value)}\n`;
  };
  return {
    emit: {
      config: () => {},
      data: append,
      rows: append,
      text: append,
      file: () => {},
      error: append,
      log: () => {},
      setExitCode: () => {},
    },
    text: () => buffer,
  };
}
