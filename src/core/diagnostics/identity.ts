import { createHash } from "node:crypto";
import { resolveMachineLabel } from "../../lib/machine.ts";

/** Stable within one machine label, but not reversible to that label. */
export function pseudonymousMachineId(machineLabel = resolveMachineLabel()): string {
  const digest = createHash("sha256")
    .update("harnery-diagnostic-machine-v1\0")
    .update(machineLabel)
    .digest("hex");
  return `machine_${digest}`;
}
