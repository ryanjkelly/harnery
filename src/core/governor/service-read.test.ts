import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { governorServiceLogPath } from "./service-read.ts";

const roots: string[] = [];
const originalSharedLogs = process.env.HARNERY_SHARED_LOGS;

afterEach(() => {
  if (originalSharedLogs === undefined) delete process.env.HARNERY_SHARED_LOGS;
  else process.env.HARNERY_SHARED_LOGS = originalSharedLogs;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("governor service log reader", () => {
  test("prefers the shared active generation and falls back to untouched history", () => {
    delete process.env.HARNERY_SHARED_LOGS;
    const root = fixture();
    const legacy = join(root, ".harnery", "governor-service", "service.log");
    const active = join(root, ".harnery", "logs", "governor-service", "active.jsonl");
    write(legacy, "historical\n");
    expect(governorServiceLogPath(root)).toBe(legacy);
    write(active, '{"schema":"harnery.log-record/v1"}\n');
    expect(governorServiceLogPath(root)).toBe(active);
  });

  test("uses only the legacy service log when the process rollback is set", () => {
    process.env.HARNERY_SHARED_LOGS = "0";
    const root = fixture();
    const legacy = join(root, ".harnery", "governor-service", "service.log");
    write(join(root, ".harnery", "logs", "governor-service", "active.jsonl"), "shared\n");
    expect(governorServiceLogPath(root)).toBe(legacy);
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-governor-service-read-"));
  roots.push(root);
  return root;
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}
