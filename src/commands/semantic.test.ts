import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarneryProgram, type EmitContext } from "../commander.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-semantic-cli-"));
  roots.push(root);
  return root;
}

async function run(argv: string[]): Promise<{ data: unknown; error: unknown }> {
  let data: unknown;
  let error: unknown;
  const emit: EmitContext = {
    data: (value: unknown) => {
      data = value;
    },
    error: (value: unknown) => {
      error = value;
    },
  } as unknown as EmitContext;
  const program = createHarneryProgram({ emit });
  try {
    await program.parseAsync(["node", "harn", ...argv]);
  } catch {
    // Refusals emit their structured error before Commander exits.
  }
  return { data, error };
}

describe("semantic command", () => {
  test("doctor reports all fixed harness routes without spending a model call", async () => {
    const root = fixture();
    const { data, error } = await run(["semantic", "doctor", "--root", root]);
    expect(error).toBeUndefined();
    expect(data).toMatchObject({
      schema_version: 1,
      root,
      readers: {
        "claude-code": { configured_model: "haiku-4.5" },
        codex: { configured_model: "gpt-5.6-luna" },
        cursor: { configured_model: "composer-2.5" },
      },
    });
  });

  test("inspect emits a bounded error when no semantic document exists", async () => {
    const root = fixture();
    const { error } = await run(["semantic", "inspect", "inst_missing", "--root", root]);
    expect(error).toEqual({
      code: "semantic_inspect_failed",
      message: "no semantic document for inst_missing",
    });
  });

  test("service status is healthy and stopped before explicit enrollment", async () => {
    const root = fixture();
    const { data, error } = await run(["semantic", "service", "status", "--root", root]);
    expect(error).toBeUndefined();
    expect(data).toMatchObject({
      running: false,
      stale: false,
      pending_count: 0,
      rolling_calls: { used: 0, limit: 120, available: 120 },
      rolling_usage: { call_count: 0, unreported_calls: 0 },
      process_usage: { call_count: 0, unreported_calls: 0 },
      routes: [
        { harness: "claude-code", configured_model: "haiku-4.5" },
        { harness: "codex", configured_model: "gpt-5.6-luna" },
        { harness: "cursor", configured_model: "composer-2.5" },
      ],
    });
  });

  test("soak reports an empty bounded window before the service has emitted passes", async () => {
    const root = fixture();
    const { data, error } = await run(["semantic", "soak", "--minutes", "15", "--root", root]);
    expect(error).toBeUndefined();
    expect(data).toMatchObject({
      schema_version: 1,
      window: { requested_minutes: 15, window_complete: false },
      service: { running: false, stale: false },
      coverage: { pass_count: 0, instrumented_pass_count: 0, accepted_reading_count: 0 },
      usage: { call_count: 0, unreported_calls: 0 },
      stability: { subject_count: 0, rapid_reversals: 0 },
    });
  });

  test("review prepare returns an empty frozen set before accepted readings exist", async () => {
    const root = fixture();
    const { data, error } = await run(["semantic", "review", "prepare", "--root", root]);
    expect(error).toBeUndefined();
    expect(data).toMatchObject({
      schema_version: 1,
      total_candidate_count: 0,
      reviewed_candidate_count: 0,
      pending_candidate_count: 0,
      candidates: [],
    });
  });
});
