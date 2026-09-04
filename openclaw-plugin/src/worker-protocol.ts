import type { HarneryOpenClawConfig, OpenClawHookName, OpenClawTranslation } from "./types.ts";

export interface RecordWorkerData {
  config: HarneryOpenClawConfig;
  packageVersion: string;
  instanceId: string;
}

export type RecordWorkerMessage =
  | { id: number; kind: "record"; hook: OpenClawHookName; translation: OpenClawTranslation }
  | { id: number; kind: "capture"; hook: OpenClawHookName; skeleton: unknown }
  | { id: number; kind: "log"; event: string; detail: Record<string, unknown> }
  | { id: number; kind: "boot"; row: Record<string, unknown> }
  | { id: number; kind: "flush" }
  | { id: number; kind: "shutdown" };

export type RecordWorkerMessageBody = RecordWorkerMessage extends infer Message
  ? Message extends { id: number }
    ? Omit<Message, "id">
    : never
  : never;

export interface RecordWorkerReply {
  id: number;
  kind: RecordWorkerMessage["kind"];
  ok: boolean;
}
