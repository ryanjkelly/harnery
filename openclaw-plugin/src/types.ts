import type { HookSignalV3 } from "../../src/core/events/v3/producers/hook.ts";
import type { ParsedPayload } from "../../src/core/hooks/adapter/parse.ts";

export const OPENCLAW_HOOKS = [
  "session_start",
  "before_prompt_build",
  "before_tool_call",
  "after_tool_call",
  "agent_end",
  "session_end",
] as const;

export type OpenClawHookName = (typeof OPENCLAW_HOOKS)[number];
export type OpenClawHookEvent = Record<string, unknown>;
export type OpenClawHookContext = Record<string, unknown> & {
  sessionKey?: string;
  runId?: string;
  agentId?: string;
  workspaceDir?: string;
  cwd?: string;
};

export interface OpenClawPluginApi {
  pluginConfig?: unknown;
  on(
    hook: OpenClawHookName,
    handler: (event: OpenClawHookEvent, context: OpenClawHookContext) => unknown,
  ): void;
  registerService?(service: {
    id: string;
    start(context?: unknown): void | Promise<void>;
    stop(context?: unknown): void | Promise<void>;
  }): void;
}

export interface HarneryOpenClawConfig {
  mode: "capture" | "record";
  ledgerRoot: string;
  logRoot: string;
  agents: readonly string[];
  debug: boolean;
  recorderFault: boolean;
  queueCapacity: number;
}

export interface OpenClawTranslation {
  signal: HookSignalV3;
  payload: ParsedPayload;
}

export type TranslationResult =
  | { value: OpenClawTranslation; reason?: never }
  | { value: null; reason: string };

export interface RecordQueueStats {
  accepted: number;
  dropped: number;
  failures: number;
  pending: number;
  closed: boolean;
}

export interface RecordQueue {
  enqueue(hook: OpenClawHookName, translation: OpenClawTranslation): Promise<void>;
  capture(hook: OpenClawHookName, skeleton: unknown): void;
  log(event: string, detail?: Record<string, unknown>): void;
  boot(row: Record<string, unknown>): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  stats(): RecordQueueStats;
}
