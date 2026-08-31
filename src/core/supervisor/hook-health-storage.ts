import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writePrivateJsonAtomic } from "../storage/atomic-json.ts";
import { SUPERVISOR_HOOK_HEALTH_SCHEMA_VERSION, type SupervisorHookHealth } from "./hook-health.ts";

export function supervisorHookHealthPath(coordRoot: string): string {
  return join(resolve(coordRoot), ".harnery", "supervisor", "hook-health.json");
}

export function writeSupervisorHookHealth(coordRoot: string, value: SupervisorHookHealth): void {
  writePrivateJsonAtomic(supervisorHookHealthPath(coordRoot), value);
}

export function readSupervisorHookHealth(coordRoot: string): SupervisorHookHealth | undefined {
  const path = supervisorHookHealthPath(coordRoot);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SupervisorHookHealth>;
    return value?.schema_version === SUPERVISOR_HOOK_HEALTH_SCHEMA_VERSION
      ? (value as SupervisorHookHealth)
      : undefined;
  } catch {
    return undefined;
  }
}
