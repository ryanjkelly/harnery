import { type EventV3ControlState, readEventV3ControlState } from "./control.ts";
import { writeEventV3 } from "./writer.ts";

/** Repair only a manifest-first crash by appending the exact pre-minted event. */
export function repairEventV3ControlPair(coordRoot: string): EventV3ControlState {
  const control = readEventV3ControlState(coordRoot);
  if (control.state !== "repairable") return control;
  const event =
    control.reason === "genesis_event_missing" ? control.genesis.event : control.activation?.event;
  if (!event) return { state: "invalid", reason: "repair_event_unavailable" };
  const result = writeEventV3(coordRoot, event);
  if (result.state !== "committed") {
    return { state: "invalid", reason: "control_event_repair_not_committed" };
  }
  return readEventV3ControlState(coordRoot);
}
