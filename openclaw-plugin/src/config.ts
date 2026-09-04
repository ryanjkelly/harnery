import { homedir } from "node:os";
import { resolve } from "node:path";
import type { HarneryOpenClawConfig } from "./types.ts";

export const DEFAULT_RECORD_QUEUE_CAPACITY = 128;

export function defaultOpenClawStateRoot(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  return resolve(
    typeof env.OPENCLAW_STATE_DIR === "string" && env.OPENCLAW_STATE_DIR.length > 0
      ? env.OPENCLAW_STATE_DIR
      : resolve(home, ".openclaw"),
  );
}

export function parsePluginConfig(
  value: unknown,
  runtime: { env?: NodeJS.ProcessEnv; home?: string } = {},
): HarneryOpenClawConfig {
  const config = record(value);
  const stateRoot = defaultOpenClawStateRoot(runtime.env, runtime.home);
  const agents = Array.isArray(config.agents)
    ? config.agents.filter(
        (agent): agent is string => typeof agent === "string" && agent.length > 0,
      )
    : ["main"];
  return {
    mode: config.mode === "record" ? "record" : "capture",
    ledgerRoot: resolve(
      typeof config.ledgerRoot === "string" && config.ledgerRoot.length > 0
        ? config.ledgerRoot
        : resolve(stateRoot, "harnery"),
    ),
    logRoot: resolve(
      typeof config.logRoot === "string" && config.logRoot.length > 0
        ? config.logRoot
        : resolve(stateRoot, "logs", "harnery"),
    ),
    agents,
    debug: typeof config.debug === "boolean" ? config.debug : true,
    recorderFault: config.recorderFault === true,
    queueCapacity: boundedCapacity(config.queueCapacity),
  };
}

function boundedCapacity(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return DEFAULT_RECORD_QUEUE_CAPACITY;
  }
  return Math.max(1, Math.min(4096, value));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
