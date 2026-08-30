import type { ResourceSnapshot } from "../resources/contract.ts";
import type { ObservedHookHealth } from "./contract.ts";

export const SUPERVISOR_LONG_HOOK_SECONDS = 120;

/**
 * Command text may label a process only after PID ancestry proved its agent
 * owner. It never establishes ownership by itself.
 */
export function collectHookHealth(resource: ResourceSnapshot): ObservedHookHealth[] {
  return resource.processes
    .filter(
      (row) =>
        row.owner_kind === "agent" &&
        row.owner_id !== null &&
        exactHookEntrypoint(row.name, row.command),
    )
    .map((row) => ({
      pid: row.pid,
      owner_id: row.owner_id!,
      state: row.state,
      age_seconds: row.age_seconds,
      cpu_percent: row.cpu_percent,
      rss_bytes: row.rss_bytes,
      command: row.command,
      long_running: row.age_seconds >= SUPERVISOR_LONG_HOOK_SECONDS,
      evidence: "validated-owner-and-exact-entrypoint" as const,
    }))
    .sort((left, right) => right.age_seconds - left.age_seconds || left.pid - right.pid);
}

export function exactHookEntrypoint(name: string, command: string): boolean {
  if (name === "agent-hook" || name === "agent-hook.exe") return true;
  return /(?:^|[\\/\s])agent-hook(?:\.exe)?(?:\s|$)/.test(command);
}
