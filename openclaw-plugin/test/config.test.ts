import { describe, expect, test } from "bun:test";
import { resolve, sep } from "node:path";
import {
  DEFAULT_RECORD_QUEUE_CAPACITY,
  defaultOpenClawStateRoot,
  parsePluginConfig,
} from "../src/config.ts";

describe("OpenClaw plugin configuration", () => {
  test("derives portable ledger and log roots from the runtime state directory", () => {
    const config = parsePluginConfig(
      {},
      {
        env: { OPENCLAW_STATE_DIR: "/srv/gateway-state" },
        home: "/portable/runtime-user",
      },
    );
    expect(config.ledgerRoot).toBe(resolve("/srv/gateway-state", "harnery"));
    expect(config.logRoot).toBe(resolve("/srv/gateway-state", "logs", "harnery"));
  });

  test("falls back to the runtime user's home without a host-specific account", () => {
    expect(defaultOpenClawStateRoot({}, "/portable/runtime-user")).toBe(
      resolve("/portable/runtime-user", ".openclaw"),
    );
  });

  test("bounds queue capacity and preserves explicit portable paths", () => {
    const explicit = parsePluginConfig(
      { ledgerRoot: "./ledger", logRoot: "./logs", queueCapacity: 0 },
      { env: {}, home: "/portable/runtime-user" },
    );
    expect(explicit.ledgerRoot.endsWith(`${sep}ledger`)).toBe(true);
    expect(explicit.logRoot.endsWith(`${sep}logs`)).toBe(true);
    expect(explicit.queueCapacity).toBe(1);
    expect(
      parsePluginConfig({ queueCapacity: 10_000 }, { env: {}, home: "/portable/runtime-user" })
        .queueCapacity,
    ).toBe(4096);
    expect(
      parsePluginConfig({ queueCapacity: "invalid" }, { env: {}, home: "/portable/runtime-user" })
        .queueCapacity,
    ).toBe(DEFAULT_RECORD_QUEUE_CAPACITY);
  });
});
