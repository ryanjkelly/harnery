/**
 * Stop-hook verdict for the V3-only runtime.
 *
 * V3 records lifecycle and turn completion authoritatively, but it does not
 * retain reply bodies. The old reply-ritual policy therefore cannot be
 * evaluated without violating V3's privacy contract. Stop remains fail-open;
 * session finalization is enforced independently by the V3 finalizer.
 */

import { readEventV3ControlState } from "../../events/v3/control.ts";

export type { VerdictResult } from "./verdict.ts";

import type { VerdictResult } from "./verdict.ts";

export interface StopHookRequest {
  rule: "stop-hook";
  instance_id: string;
  session_id?: string;
  adapter?: string;
  now_ms?: number;
  turn_window?: { start_ms: number; end_ms: number };
  bypass?: boolean;
  workflow_child?: boolean;
}

export const STOP_REMEDIATION_MARKER = "[harnery:stop-remediation";

export function evaluateStopHook(coordRoot: string, req: StopHookRequest): VerdictResult {
  if (req.bypass) {
    return {
      allow: true,
      exit_code: 0,
      rule: "stop-hook.bypass",
      reason: "HARNERY_AGENT_COORD_BYPASS_STOP=1",
    };
  }
  if (req.workflow_child) {
    return {
      allow: true,
      exit_code: 0,
      rule: "stop-hook.workflow_child",
      reason: "HARNERY_WORKFLOW_CHILD=1: headless workflow child; ritual not applicable",
    };
  }
  if (req.adapter === "codex") {
    return {
      allow: true,
      exit_code: 0,
      rule: "stop-hook.codex_observe_only",
      reason: "Codex Stop continuations must not replace the user-facing answer",
    };
  }

  const control = readEventV3ControlState(coordRoot);
  return {
    allow: true,
    exit_code: 0,
    rule: "stop-hook.v3_reply_evidence_unavailable",
    reason:
      control.state === "candidate" || control.state === "active"
        ? "V3 intentionally does not retain reply bodies; session finalization is enforced separately"
        : `V3 control state is ${control.state}; Stop remains fail-open`,
  };
}
