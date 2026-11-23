/**
 * The schedule reader registry (ADR 0271): every built-in reader, the
 * project-only opt-in check for readers of another app's private store, and
 * the one function that merges every source and captured observation into a
 * single list with a coverage row per source.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMachineLabel } from "../../lib/machine.ts";
import { scheduleConfig } from "../config.ts";
import {
  capturedScheduleRecords,
  readScheduleObservations,
  scheduleObservationKey,
  scheduleObservationsById,
} from "./capture.ts";
import { defaultScheduleCommandRunner } from "./command-runner.ts";
import { codexAppScheduleReader } from "./readers/codex-app.ts";
import { harneryScheduleReader } from "./readers/harnery.ts";
import { osTimersScheduleReader } from "./readers/os-timers.ts";
import { t3CodeScheduleReader } from "./readers/t3-code.ts";
import {
  applyScheduleObservation,
  SCHEDULE_OPT_IN_READERS,
  SCHEDULE_SOURCES,
  type ScheduleCommandRunner,
  type ScheduleReadContext,
  type ScheduleReader,
  type ScheduleReadResult,
  type ScheduleRecord,
  type ScheduleSource,
  type ScheduleSourceCoverage,
  scheduleRecordKey,
  validateScheduleReadResult,
} from "./types.ts";

/** Registered schedule readers. `captured` has no reader: observations stand in for one. */
export const SCHEDULE_READERS: readonly ScheduleReader[] = [
  t3CodeScheduleReader,
  codexAppScheduleReader,
  osTimersScheduleReader,
  harneryScheduleReader,
];

/** The registered reader for a source, or undefined (always undefined for `captured`). */
export function scheduleReaderFor(source: ScheduleSource): ScheduleReader | undefined {
  return SCHEDULE_READERS.find((reader) => reader.id === source);
}

/** Whether a reader needs the project's opt-in before it may run. */
export function scheduleReaderRequiresOptIn(reader: ScheduleReader): boolean {
  return reader.requiresOptIn || (SCHEDULE_OPT_IN_READERS as readonly string[]).includes(reader.id);
}

/**
 * Whether the reader may run in this project. An opt-in reader runs only when
 * the project's own `.harnery/config.jsonc` lists it under `schedule.readers`
 * (`scheduleConfig` reads that file alone, never a user-global or local one).
 */
export function isScheduleReaderEnabled(reader: ScheduleReader, coordRoot: string): boolean {
  if (!scheduleReaderRequiresOptIn(reader)) return true;
  return (scheduleConfig(coordRoot).readers as readonly string[]).includes(reader.id);
}

export interface ReadAllSchedulesOptions {
  coordRoot: string;
  /** Defaults to `resolveMachineLabel()`. */
  machine?: string;
  /** Defaults to the user's home directory. */
  homeDir?: string;
  /** Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to `defaultScheduleCommandRunner`. */
  runCommand?: ScheduleCommandRunner;
  /** Test override of each reader's store location. */
  storePaths?: Partial<Record<ScheduleSource, string>>;
  /** Defaults to `SCHEDULE_READERS`. */
  readers?: readonly ScheduleReader[];
  /**
   * Instance ids of live sessions, used to drop in-session timers whose
   * session ended. Omitted: read from the live coordination view. `null`:
   * keep every in-session timer.
   */
  liveInstanceIds?: ReadonlySet<string> | null;
}

/** The merged list: records from every source and one coverage row per source. */
export interface ScheduleList {
  records: ScheduleRecord[];
  /** One row per source in `SCHEDULE_SOURCES` order, always. */
  coverage: ScheduleSourceCoverage[];
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").trim();
}

async function runReader(
  reader: ScheduleReader,
  ctx: ScheduleReadContext,
  enabled: boolean,
): Promise<ScheduleReadResult> {
  const readAt = () => new Date(ctx.now()).toISOString();
  if (!enabled) {
    return {
      coverage: {
        source: reader.id,
        account: ctx.machine,
        state: "disabled",
        detail: `This project has not turned on the ${reader.id} reader (schedule.readers in .harnery/config.jsonc).`,
        read_at: readAt(),
      },
      records: [],
    };
  }
  const unreadable = (detail: string): ScheduleReadResult => ({
    coverage: {
      source: reader.id,
      account: ctx.machine,
      state: "unreadable",
      detail,
      read_at: readAt(),
    },
    records: [],
  });
  let result: ScheduleReadResult;
  try {
    result = await reader.read(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unreadable(`The ${reader.id} reader failed: ${firstLine(message) || "unknown error"}.`);
  }
  const checked = validateScheduleReadResult(result);
  if (!checked.ok) {
    return unreadable(`The ${reader.id} reader returned an invalid answer: ${checked.errors[0]}.`);
  }
  if (checked.value.coverage.source !== reader.id) {
    return unreadable(`The ${reader.id} reader answered for another source.`);
  }
  return {
    coverage: checked.value.coverage,
    records: checked.value.records.filter((record) => record.source === reader.id),
  };
}

async function defaultLiveInstanceIds(coordRoot: string): Promise<ReadonlySet<string> | undefined> {
  try {
    const { readLiveCoordinationRows } = await import("../agents/state/live-coordination-view.ts");
    const rows = readLiveCoordinationRows(coordRoot);
    // An empty answer may mean the view could not be read; keep timers rather than hide them.
    if (rows.length === 0) return undefined;
    const ids = new Set<string>();
    for (const row of rows) {
      if (row.instance_id) ids.add(row.instance_id);
      if (row.v3_instance_id) ids.add(row.v3_instance_id);
    }
    return ids;
  } catch {
    return undefined;
  }
}

/**
 * Read every source and captured observation into one list. Never throws for
 * a reader's failure: that source reports `unreadable` and the rest return.
 */
export async function readAllSchedules(opts: ReadAllSchedulesOptions): Promise<ScheduleList> {
  const { coordRoot } = opts;
  const machine = opts.machine ?? resolveMachineLabel();
  const now = opts.now ?? Date.now;
  const readers = opts.readers ?? SCHEDULE_READERS;
  const tmpRoot = mkdtempSync(join(tmpdir(), "harnery-schedule-"));
  try {
    const results = await Promise.all(
      readers.map((reader) => {
        const ctx: ScheduleReadContext = {
          coordRoot,
          env: opts.env ?? process.env,
          homeDir: opts.homeDir ?? homedir(),
          platform: opts.platform ?? process.platform,
          machine,
          now,
          runCommand: opts.runCommand ?? defaultScheduleCommandRunner,
          // Each reader gets its own folder so two store copies never collide.
          tmpDir: join(tmpRoot, reader.id),
          ...(opts.storePaths ? { storePaths: opts.storePaths } : {}),
        };
        try {
          return runReader(reader, ctx, isScheduleReaderEnabled(reader, coordRoot));
        } catch (error) {
          // isScheduleReaderEnabled or the context setup failed before the reader ran.
          return runReader({ ...reader, read: () => Promise.reject(error) }, ctx, true);
        }
      }),
    );

    const observations = readScheduleObservations(coordRoot);
    const observed = scheduleObservationsById(observations);
    const merged = new Map<string, ScheduleRecord>();
    const coverageBySource = new Map<ScheduleSource, ScheduleSourceCoverage>();
    for (const result of results) {
      coverageBySource.set(result.coverage.source, result.coverage);
      for (const record of result.records) {
        const key = scheduleRecordKey(record);
        if (merged.has(key)) continue;
        const observation = observed.get(scheduleObservationKey(record.source, record.id));
        merged.set(key, observation ? applyScheduleObservation(record, observation) : record);
      }
    }

    const live =
      opts.liveInstanceIds === null
        ? undefined
        : (opts.liveInstanceIds ?? (await defaultLiveInstanceIds(coordRoot)));
    const captured = capturedScheduleRecords(observations, {
      machine,
      ...(live ? { liveInstanceIds: live } : {}),
    });
    for (const record of captured) {
      const key = scheduleRecordKey(record);
      if (!merged.has(key)) merged.set(key, record);
    }
    const readAt = new Date(now()).toISOString();
    coverageBySource.set("captured", {
      source: "captured",
      account: machine,
      state: "current",
      read_at: readAt,
    });

    const coverage = SCHEDULE_SOURCES.map(
      (source): ScheduleSourceCoverage =>
        coverageBySource.get(source) ?? {
          source,
          account: machine,
          state: "unsupported",
          detail: `No reader is registered for ${source}.`,
          read_at: readAt,
        },
    );
    return { records: [...merged.values()], coverage };
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}
