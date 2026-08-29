import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  processLogDestination,
  RotatingTextSink,
  runRotatingProcessSync,
  spawnRotatingProcess,
} from "./process-log.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("rotating text sink", () => {
  test("bounds the active process log and rotates backups", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-text-"));
    roots.push(root);
    const path = join(root, "service.log");
    const sink = new RotatingTextSink({ path, max_bytes: 5, backups: 2 });
    sink.append("12345");
    sink.append("abc");
    sink.close();
    expect(readFileSync(path, "utf8")).toBe("abc");
    expect(existsSync(`${path}.1`)).toBeTrue();
    expect(Bun.file(path).size).toBeLessThanOrEqual(5);
    expect(Bun.file(`${path}.1`).size).toBeLessThanOrEqual(5);
  });

  test("resolves the catalog partition by default and exact legacy path on rollback", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-process-destination-"));
    roots.push(root);
    const legacy = join(root, ".cache", "tunnel", "gate.log");
    expect(
      processLogDestination({
        coord_root: root,
        family_id: "tunnel-process-log",
        filename: "gate.log",
        legacy_path: legacy,
        env: {},
      }),
    ).toBe(join(root, ".harnery", "logs", "tunnel-process", "gate.log"));
    expect(
      processLogDestination({
        coord_root: root,
        family_id: "tunnel-process-log",
        filename: "gate.log",
        legacy_path: legacy,
        env: { HARNERY_SHARED_LOGS: "0" },
      }),
    ).toBe(legacy);
  });

  test("captures a new bounded generation without touching the legacy file", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-process-run-"));
    roots.push(root);
    const legacy = join(root, "legacy.log");
    const shared = join(root, "shared", "active.log");
    writeFileSync(legacy, "legacy-untouched\n");
    mkdirSync(join(root, "shared"));
    writeFileSync(shared, "prior-generation\n", { flag: "w" });
    const status = runRotatingProcessSync({
      path: shared,
      command: process.execPath,
      arguments: ["-e", 'process.stdout.write("1234567890")'],
      max_bytes: 6,
      backups: 2,
    });
    expect(status).toBe(0);
    expect(readFileSync(legacy, "utf8")).toBe("legacy-untouched\n");
    expect(Bun.file(shared).size).toBeLessThanOrEqual(6);
    expect(Bun.file(`${shared}.1`).size).toBeLessThanOrEqual(6);
  });

  test("the detached wrapper continuously captures and bounds child output", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-process-wrapper-"));
    roots.push(root);
    const path = join(root, "worker.log");
    const child = spawnRotatingProcess({
      path,
      command: process.execPath,
      arguments: ["-e", 'process.stdout.write("1234567890")'],
      max_bytes: 6,
      backups: 2,
    });
    expect(
      await new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code))),
    ).toBe(0);
    expect(Bun.file(path).size).toBeLessThanOrEqual(6);
    expect(Bun.file(`${path}.1`).size).toBeLessThanOrEqual(6);
  });
});
