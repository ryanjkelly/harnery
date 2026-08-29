import { describe, expect, test } from "bun:test";
import { createStorageCatalog } from "./catalog.ts";
import {
  createInMemoryLoggerRuntime,
  createNullLoggerRuntime,
  HarneryUnsupportedDurabilityError,
} from "./logger.ts";

const bindings = [{ component_id: "canary", family_id: "agent-hook-debug-log" }] as const;

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
});
