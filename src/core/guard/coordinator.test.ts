import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEventLedgerV3 } from "../events/v3/bootstrap.ts";
import { sha256V3 } from "../events/v3/canonical.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../events/v3/live-routing.ts";
import { evaluateRunQualityIfDue } from "./coordinator.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("V3 run-quality coordinator", () => {
  test("evaluates the active generation and honors the due cursor", () => {
    const project = fixture("report");
    seedRepeatedRead(project);

    const first = evaluateRunQualityIfDue(
      project,
      new Date("2026-08-18T12:00:00.000Z"),
      "instance-a",
    );
    expect(first.evaluated).toBeTrue();
    expect(first.snapshot?.status).toBe("attention");
    expect(first.snapshot?.instance_id).toBe("inst_instance-a");
    expect(existsSync(join(project, ".harnery", "guard", "cursor.json"))).toBeTrue();

    const second = evaluateRunQualityIfDue(
      project,
      new Date("2026-08-18T12:00:01.000Z"),
      "instance-a",
    );
    expect(second.evaluated).toBeFalse();
    expect(second.snapshot?.status).toBe("attention");
  });

  test("invalid config is recorded once without touching the event ledger", () => {
    const project = fixture("report", { max_tail_bytes: 1 });
    const before = readFileSync(
      join(project, ".harnery", "ledgers", "v3", "active.ndjson"),
      "utf8",
    );

    const first = evaluateRunQualityIfDue(project, new Date("2026-08-18T12:00:00.000Z"));
    const second = evaluateRunQualityIfDue(project, new Date("2026-08-18T12:01:00.000Z"));

    expect(first.config.valid).toBeFalse();
    expect(second.evaluated).toBeFalse();
    expect(existsSync(join(project, ".harnery", "guard", "config-invalid.json"))).toBeTrue();
    expect(readFileSync(join(project, ".harnery", "ledgers", "v3", "active.ndjson"), "utf8")).toBe(
      before,
    );
  });
});

function fixture(mode: "shadow" | "report", extra: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v3-quality-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  writeFileSync(
    join(root, ".harnery", "config.jsonc"),
    `${JSON.stringify({
      coord: {
        run_quality: {
          mode,
          evaluation_interval_seconds: 10,
          thresholds: {
            repeated_tool_calls: 2,
            consecutive_failures: 2,
            context_growth_per_minute: 100,
            compaction_grace_seconds: 30,
            no_progress_evaluations: 2,
          },
          ...extra,
        },
      },
    })}\n`,
  );
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("config"),
    approvalRecordId: "test-quality-coordinator",
  });
  return root;
}

function seedRepeatedRead(root: string): void {
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("expected active V3 route");
  const record = (eventName: string, payload: Record<string, unknown>) =>
    recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName,
      payload: { session_id: "session-a", raw: {}, ...payload },
      adapter: "claude-code",
      instanceId: "instance-a",
    });
  record("session-start", {});
  record("user-prompt-submit", { prompt: "inspect" });
  record("pre-tool-use", {
    tool_use_id: "read-1",
    tool_name: "Read",
    tool_input: { file_path: "/workspace/a.ts" },
  });
  record("post-tool-use", {
    tool_use_id: "read-1",
    tool_name: "Read",
    tool_response: "ok",
  });
  record("pre-tool-use", {
    tool_use_id: "read-2",
    tool_name: "Read",
    tool_input: { file_path: "/workspace/a.ts" },
  });
}
