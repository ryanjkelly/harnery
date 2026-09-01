/** Read-only access to the generation-bound heartbeat cache. */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { AgentActivity, TaskState } from "./session-state.ts";

export interface Heartbeat {
  schema_version?: number;
  instance_id: string;
  name?: string;
  kind?: string;
  agent_id?: string;
  session_id: string;
  /** Native adapter session ID retained only in a generation-bound local projection. */
  native_session_id?: string;
  subagent_call_id?: string;
  model?: string;
  platform?: string;
  started_at?: string;
  last_heartbeat: string;
  files_touched: string[];
  task?: string;
  task_updated_at?: string | null;
  activity?: AgentActivity;
  activity_updated_at?: string;
  activity_source?: string;
  task_state?: TaskState;
  task_state_updated_at?: string;
  task_state_reason?: string;
  /** Session name built on the first non-empty set-task (never rebuilt). */
  suggested_session_name?: string;
  /** Stamped once the suggested name is seen in assistant reply text. */
  session_name_seen_at?: string;
  /** The specific suggested name proven present by the sighting stamp. */
  session_name_seen_for?: string;
  /**
   * The suggested name the agent was last actually instructed to display.
   * Usually identical to `suggested_session_name`; it differs only when the
   * title changed after the instruction went out, and a display of it still
   * counts so that drift cannot strand the latch.
   */
  session_name_display_requested_for?: string;
  last_status_at?: string;
  current_turn_id?: string;
  parent_instance_id?: string;
  workflow_run_id?: string;
  workflow_agent_id?: string;
  /** Disposable-cache bindings that prove a row belongs to the current V3 generation. */
  v3_instance_id?: `inst_${string}`;
  v3_generation_id?: `gen_${string}`;
  v3_projection_event_id?: string;
  v3_task_state?: "set" | "cleared";
  [extra: string]: unknown;
}

export function heartbeatPath(coordRoot: string, instanceId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(instanceId)) {
    throw new Error("instance_id must be 1-128 ASCII letters, digits, hyphens, or underscores");
  }
  const root = resolve(coordRoot, ".harnery", "active");
  const candidate = resolve(root, `${instanceId}.json`);
  if (!candidate.startsWith(`${root}${sep}`) || dirname(candidate) !== root) {
    throw new Error("coordination filename must resolve directly beneath its root");
  }
  return candidate;
}

export function readHeartbeat(coordRoot: string, instanceId: string): Heartbeat | null {
  const path = heartbeatPath(coordRoot, instanceId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Heartbeat;
  } catch {
    return null;
  }
}
