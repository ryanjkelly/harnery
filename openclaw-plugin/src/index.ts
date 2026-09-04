import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/core";
import packageJson from "../package.json";
import { parsePluginConfig } from "./config.ts";
import { createRecordQueue } from "./record.ts";
import { captureSkeleton } from "./redact.ts";
import { translateOpenClawHook } from "./translate.ts";
import {
  type HarneryOpenClawConfig,
  OPENCLAW_HOOKS,
  type OpenClawPluginApi,
  type RecordQueue,
} from "./types.ts";

export interface PluginRuntimeDependencies {
  createQueue?: (config: HarneryOpenClawConfig) => RecordQueue;
  bundleSha256?: () => string;
}

export function createPluginDefinition(dependencies: PluginRuntimeDependencies = {}) {
  return {
    id: "harnery",
    name: "Harnery",
    description: "Records OpenClaw hook evidence into Harnery Event Ledger V3.",
    register(api: OpenClawPluginApi): void {
      const config = parsePluginConfig(api.pluginConfig);
      const queue =
        dependencies.createQueue?.(config) ??
        createRecordQueue(config, { packageVersion: packageJson.version });

      queue.boot({
        package_version: packageJson.version,
        index_sha256: dependencies.bundleSha256?.() ?? currentBundleSha256(),
        ledger_root: config.ledgerRoot,
        log_root: config.logRoot,
        mode: config.mode,
        queue_capacity: config.queueCapacity,
      });

      api.registerService?.({
        id: "harnery-event-recorder",
        start: () => undefined,
        stop: () => queue.close(),
      });

      for (const hook of OPENCLAW_HOOKS) {
        api.on(hook, (event = {}, context = {}) => {
          try {
            const agentId =
              typeof context.agentId === "string" && context.agentId.length > 0
                ? context.agentId
                : "main";
            if (config.agents.length > 0 && !config.agents.includes(agentId)) {
              queue.log("agent_skipped", { hook, agent_id: agentId });
              return undefined;
            }
            if (config.mode === "capture") {
              queue.capture(hook, captureSkeleton(event, context));
              return undefined;
            }
            const translated = translateOpenClawHook(hook, event, context);
            if (!translated.value) {
              queue.log("translation_skipped", { hook, reason: translated.reason });
              return undefined;
            }
            void queue.enqueue(hook, translated.value);
          } catch {
            queue.log("handler_failure", {
              hook,
              error_name: "Error",
            });
          }
          return undefined;
        });
      }
    },
  };
}

function currentBundleSha256(): string {
  try {
    return createHash("sha256")
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex");
  } catch {
    return "unavailable";
  }
}

export default definePluginEntry(createPluginDefinition());
