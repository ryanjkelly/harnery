import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OPENCLAW_HOOKS, type OpenClawHookName } from "./types.ts";

const SAFE_SKELETON_TYPES = new Set([
  "array",
  "bigint",
  "boolean",
  "function",
  "null",
  "number",
  "object",
  "string",
  "symbol",
  "undefined",
]);

export interface NativeShapeFixture {
  source: {
    kind: "native_capture";
    openclaw_version: string;
    captured_at: string;
    input: "capture-mode-debug";
  };
  hook: OpenClawHookName;
  skeleton: { event: unknown; context: unknown };
}

export function intakeCaptureRows(raw: string, openclawVersion: string): NativeShapeFixture[] {
  if (!/^[0-9A-Za-z._+-]{1,80}$/.test(openclawVersion)) {
    throw new Error("invalid_openclaw_version");
  }
  const fixtures = new Map<OpenClawHookName, NativeShapeFixture>();
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = asRecord(JSON.parse(line));
    } catch {
      throw new Error(`invalid_capture_json:${index + 1}`);
    }
    if (row.event !== "capture") continue;
    const hook = row.hook;
    if (typeof hook !== "string" || !OPENCLAW_HOOKS.includes(hook as OpenClawHookName)) {
      throw new Error(`invalid_capture_hook:${index + 1}`);
    }
    if (fixtures.has(hook as OpenClawHookName)) {
      throw new Error(`duplicate_capture_hook:${hook}`);
    }
    const skeleton = asRecord(row.skeleton);
    if (!("event" in skeleton) || !("context" in skeleton)) {
      throw new Error(`invalid_capture_skeleton:${index + 1}`);
    }
    assertSafeSkeleton(skeleton.event, ["event"]);
    assertSafeSkeleton(skeleton.context, ["context"]);
    const capturedAt = row.observed_at;
    if (typeof capturedAt !== "string" || !Number.isFinite(Date.parse(capturedAt))) {
      throw new Error(`invalid_capture_timestamp:${index + 1}`);
    }
    fixtures.set(hook as OpenClawHookName, {
      source: {
        kind: "native_capture",
        openclaw_version: openclawVersion,
        captured_at: capturedAt,
        input: "capture-mode-debug",
      },
      hook: hook as OpenClawHookName,
      skeleton: { event: skeleton.event, context: skeleton.context },
    });
  }
  const missing = OPENCLAW_HOOKS.filter((hook) => !fixtures.has(hook));
  if (missing.length > 0) throw new Error(`missing_capture_hooks:${missing.join(",")}`);
  return OPENCLAW_HOOKS.map((hook) => fixtures.get(hook)!);
}

export function writeCaptureFixtures(
  inputPath: string,
  outputDir: string,
  openclawVersion: string,
): string[] {
  const fixtures = intakeCaptureRows(readFileSync(inputPath, "utf8"), openclawVersion);
  mkdirSync(outputDir, { recursive: true });
  return fixtures.map((fixture) => {
    const path = join(outputDir, `${fixture.hook.replaceAll("_", "-")}.json`);
    writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return path;
  });
}

function assertSafeSkeleton(
  value: unknown,
  path: string[],
  allowance: { length?: boolean; array?: boolean } = {},
): void {
  if (typeof value === "string") {
    const joined = path.join(".");
    const trustedIdentity =
      joined === "event.toolCallId" ||
      joined === "context.sessionKey" ||
      joined === "context.runId" ||
      joined === "context.agentId";
    const safeType = path.at(-1) === "type" && SAFE_SKELETON_TYPES.has(value);
    if (!trustedIdentity && !safeType) throw new Error(`capture_contains_raw_string:${joined}`);
    return;
  }
  if (typeof value === "number") {
    if (allowance.length && Number.isSafeInteger(value) && value >= 0) return;
    throw new Error(`capture_contains_raw_number:${path.join(".")}`);
  }
  if (typeof value === "boolean" || value === null) {
    throw new Error(`capture_contains_raw_primitive:${path.join(".")}`);
  }
  if (Array.isArray(value)) {
    if (!allowance.array) throw new Error(`capture_contains_raw_array:${path.join(".")}`);
    value.forEach((child, index) => {
      assertSafeSkeleton(child, [...path, String(index)]);
    });
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`capture_contains_unsupported_value:${path.join(".")}`);
  }
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    assertSafeSkeleton(child, [...path, key], {
      length: key === "length" && (record.type === "string" || record.type === "array"),
      array: key === "items" && record.type === "array",
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected_object");
  }
  return value as Record<string, unknown>;
}
