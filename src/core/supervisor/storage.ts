import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CoordinationHealthSnapshot } from "../agents/health.ts";
import type {
  SupervisorConsumerRecord,
  SupervisorActivitySnapshot,
  SupervisorFindingExplanation,
  SupervisorFindings,
  SupervisorHistory,
  SupervisorLogFeed,
  SupervisorServiceStatusRecord,
  SupervisorSnapshot,
  SupervisorTimeline,
} from "./contract.ts";

export interface SupervisorPaths {
  root: string;
  service: string;
  lease: string;
  stop: string;
  snapshot: string;
  history: string;
  activity: string;
  findings: string;
  timelines: string;
  explanations: string;
  coordination_health: string;
  log_feed: string;
  consumers: string;
}

export function supervisorPaths(coordRootRaw: string): SupervisorPaths {
  const root = join(resolve(coordRootRaw), ".harnery", "supervisor");
  return {
    root,
    service: join(root, "service.json"),
    lease: join(root, "service.lease.json"),
    stop: join(root, "stop.json"),
    snapshot: join(root, "snapshot.json"),
    history: join(root, "history.json"),
    activity: join(root, "activity.json"),
    findings: join(root, "findings.json"),
    timelines: join(root, "timelines"),
    explanations: join(root, "explanations"),
    coordination_health: join(root, "coordination-health.json"),
    log_feed: join(root, "log-feed.json"),
    consumers: join(root, "consumers"),
  };
}

export function supervisorConsumerPath(coordRoot: string, id: string): string {
  return join(supervisorPaths(coordRoot).consumers, `${safeId(id)}.json`);
}

export function readSupervisorServiceRecord(
  coordRoot: string,
): SupervisorServiceStatusRecord | undefined {
  return readJson<SupervisorServiceStatusRecord>(supervisorPaths(coordRoot).service);
}

export function readSupervisorSnapshot(coordRoot: string): SupervisorSnapshot | undefined {
  return readJson<SupervisorSnapshot>(supervisorPaths(coordRoot).snapshot);
}

export function readSupervisorHistory(coordRoot: string): SupervisorHistory | undefined {
  return readJson<SupervisorHistory>(supervisorPaths(coordRoot).history);
}

export function readSupervisorActivity(coordRoot: string): SupervisorActivitySnapshot | undefined {
  return readJson<SupervisorActivitySnapshot>(supervisorPaths(coordRoot).activity);
}

export function readSupervisorFindings(coordRoot: string): SupervisorFindings | undefined {
  return readJson<SupervisorFindings>(supervisorPaths(coordRoot).findings);
}

export function readSupervisorTimeline(
  coordRoot: string,
  findingId: string,
): SupervisorTimeline | undefined {
  return readJson<SupervisorTimeline>(
    join(supervisorPaths(coordRoot).timelines, `${safeId(findingId)}.json`),
  );
}

export function readSupervisorExplanation(
  coordRoot: string,
  findingId: string,
): SupervisorFindingExplanation | undefined {
  return readJson<SupervisorFindingExplanation>(
    join(supervisorPaths(coordRoot).explanations, `${safeId(findingId)}.json`),
  );
}

export function readCoordinationHealthSnapshot(
  coordRoot: string,
): CoordinationHealthSnapshot | undefined {
  return readJson<CoordinationHealthSnapshot>(supervisorPaths(coordRoot).coordination_health);
}

export function readSupervisorLogFeed(coordRoot: string): SupervisorLogFeed | undefined {
  return readJson<SupervisorLogFeed>(supervisorPaths(coordRoot).log_feed);
}

export function readSupervisorConsumer(path: string): SupervisorConsumerRecord | undefined {
  return readJson<SupervisorConsumerRecord>(path);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}

function safeId(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("supervisor consumer id must contain a letter or number");
  return normalized.slice(0, 80);
}
