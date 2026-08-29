import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorageCatalog } from "./catalog.ts";
import {
  closeProcessLoggers,
  createInMemoryLoggerRuntime,
  createNullLoggerRuntime,
  HarneryUnsupportedDurabilityError,
  processLogger,
} from "./logger.ts";

const bindings = [{ component_id: "canary", family_id: "agent-hook-debug-log" }] as const;
const roots: string[] = [];

afterEach(async () => {
  await closeProcessLoggers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Harnery logger facade", () => {
  test("does not evaluate lazy fields below the configured level", async () => {
    const catalog = createStorageCatalog(
      { coord_root: "/tmp/harnery-logger-test" },
      { logger_bindings: bindings },
    );
    const runtime = createInMemoryLoggerRuntime({
      catalog,
      bindings,
      env: { HARNERY_LOG_LEVEL: "error" },
    });
    let called = false;
    const logger = runtime.logger("canary");
    logger.debug("canary.disabled", () => {
      called = true;
      return {};
    });
    await logger.flush();
    expect(called).toBeFalse();
    expect(runtime.records).toHaveLength(0);
  });

  test("isolates child context and rejects private fields before storage", async () => {
    const catalog = createStorageCatalog(
      { coord_root: "/tmp/harnery-logger-test" },
      { logger_bindings: bindings },
    );
    const runtime = createInMemoryLoggerRuntime({ catalog, bindings });
    const root = runtime.logger("canary", { session_id: "root" });
    root.child({ task_id: "child" }).info("canary.child", { ok: true });
    root.info("canary.private", { prompt: "never persist" });
    await runtime.close();
    expect(runtime.records).toHaveLength(1);
    expect(runtime.records[0]?.context).toEqual({ session_id: "root", task_id: "child" });
  });

  test("rejects durable flush for best-effort families and supports a null runtime", async () => {
    const catalog = createStorageCatalog(
      { coord_root: "/tmp/harnery-logger-test" },
      { logger_bindings: bindings },
    );
    const runtime = createInMemoryLoggerRuntime({ catalog, bindings });
    await expect(runtime.flush({ durability: "disk" })).rejects.toBeInstanceOf(
      HarneryUnsupportedDurabilityError,
    );
    expect(createNullLoggerRuntime().logger("anything").isEnabled("fatal")).toBeFalse();
  });

  test("binds process service components to their catalog families", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-process-loggers-"));
    roots.push(root);
    processLogger(root, "semantic-service").info("semantic.started");
    processLogger(root, "governor-service").info("governor.started");
    processLogger(root, "presence-relay").info("presence.started");
    await closeProcessLoggers();

    for (const [partition, familyId] of [
      ["semantic-service", "semantic-service-log"],
      ["governor-service", "governor-service-log"],
      ["presence-relay", "presence-relay-log"],
    ]) {
      const path = join(root, ".harnery", "logs", partition!, "active.jsonl");
      expect(existsSync(path), partition).toBeTrue();
      expect(readFileSync(path, "utf8"), partition).toContain(`"family_id":"${familyId}"`);
    }
  });
});
