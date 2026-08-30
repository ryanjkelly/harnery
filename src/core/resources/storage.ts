import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ResourceServiceStatusRecord, ResourceSnapshot } from "./contract.ts";

export { writePrivateJsonAtomic } from "../storage/atomic-json.ts";

export interface ResourcePaths {
  root: string;
  service: string;
  lease: string;
  stop: string;
  snapshot: string;
}

export function resourcePaths(coordRootRaw: string): ResourcePaths {
  const root = join(resolve(coordRootRaw), ".harnery", "resources");
  return {
    root,
    service: join(root, "service.json"),
    lease: join(root, "service.lease.json"),
    stop: join(root, "stop.json"),
    snapshot: join(root, "snapshot.json"),
  };
}

export function readResourceSnapshot(coordRoot: string): ResourceSnapshot | undefined {
  return readJson<ResourceSnapshot>(resourcePaths(coordRoot).snapshot);
}

export function readResourceServiceRecord(
  coordRoot: string,
): ResourceServiceStatusRecord | undefined {
  return readJson<ResourceServiceStatusRecord>(resourcePaths(coordRoot).service);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}
