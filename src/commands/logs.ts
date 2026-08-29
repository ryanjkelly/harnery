import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { createStorageCatalog } from "../core/storage/catalog.ts";
import type { HarneryLogLevel, HarneryRegisteredStorageFamily } from "../core/storage/contract.ts";
import { queryLogs, rotationFollowCursor } from "../core/storage/query.ts";
import { familyLogDirectory, readSegmentManifest } from "../core/storage/segments.ts";

interface QueryOptions {
  family?: string[];
  level?: HarneryLogLevel;
  event?: string;
  since?: string;
  until?: string;
  maxRecords: number;
  maxBytes: number;
  json?: boolean;
}

export function registerLogsCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  const logs = program.command("logs").description("List and query bounded Harnery log families");
  logs
    .command("list")
    .option("--json", "Emit structured output")
    .action((options: { json?: boolean }) =>
      run(emit, async () => {
        const families = logFamilies(catalogFor(context).families);
        const rows = families.map((family) => {
          const directory = familyLogDirectory(family);
          const manifest = readSegmentManifest(directory, family);
          return {
            family_id: family.id,
            class: family.storage_class,
            directory,
            sealed_segments: manifest.segments.length,
            policy_version: family.policy.policy_version,
          };
        });
        if (options.json) {
          emit.config({ format: "json" });
          emit.data({ schema: "harnery.logs-list/v1", families: rows });
        } else emit.rows(rows);
      }),
    );

  const configureQuery = (command: Command) =>
    command
      .option("--family <id...>", "Restrict to named families")
      .option("--level <level>", "Minimum severity")
      .option("--event <event>", "Exact event name")
      .option("--since <timestamp>", "Earliest timestamp")
      .option("--until <timestamp>", "Latest timestamp")
      .option("--max-records <n>", "Global record scan budget", integer, 10_000)
      .option("--max-bytes <n>", "Global byte scan budget", integer, 10 * 1024 * 1024)
      .option("--json", "Emit structured output");

  configureQuery(logs.command("query").description("Query sealed and active log segments")).action(
    (options: QueryOptions) =>
      run(emit, async () => {
        const result = await queryLogs(
          logFamilies(catalogFor(context).families),
          queryFrom(options),
        );
        if (options.json) {
          emit.config({ format: "json" });
          emit.data({ schema: "harnery.logs-query/v1", ...result });
        } else emit.rows(result.records as unknown as Record<string, unknown>[]);
      }),
  );

  configureQuery(logs.command("export").description("Export matching records as JSONL")).action(
    (options: QueryOptions) =>
      run(emit, async () => {
        const result = await queryLogs(
          logFamilies(catalogFor(context).families),
          queryFrom(options),
        );
        for (const record of result.records) emit.text(JSON.stringify(record));
        if (result.truncated)
          emit.log("log export stopped at the configured global scan budget", "warn");
      }),
  );

  logs
    .command("tail")
    .argument("<family>")
    .description("Read recent records and a rotation-aware follow cursor")
    .option("-n, --lines <n>", "Number of recent records", integer, 50)
    .option("--max-bytes <n>", "Global byte scan budget", integer, 10 * 1024 * 1024)
    .action((familyId: string, options: { lines: number; maxBytes: number }) =>
      run(emit, async () => {
        const family = catalogFor(context).require(familyId);
        if (!isLogFamily(family)) throw new Error(`storage family is not a log: ${familyId}`);
        const result = await queryLogs([family], {
          max_records: 10_000,
          max_bytes: options.maxBytes,
        });
        emit.data({
          schema: "harnery.logs-tail-cursor/v1",
          records: result.records.slice(-options.lines),
          truncated: result.truncated,
          cursor: rotationFollowCursor(family),
        });
      }),
    );
}

function catalogFor(context?: HarneryProgramContext) {
  const coordRoot = resolve(
    context?.resolveCoordRoot?.() ??
      context?.repoRoot ??
      process.env.HARNERY_COORD_ROOT ??
      process.cwd(),
  );
  return createStorageCatalog(
    { coord_root: coordRoot, project_root: resolve(context?.repoRoot ?? coordRoot) },
    context?.storage,
  );
}

function logFamilies(
  families: readonly HarneryRegisteredStorageFamily[],
): HarneryRegisteredStorageFamily[] {
  return families.filter(isLogFamily);
}
function isLogFamily(family: HarneryRegisteredStorageFamily): boolean {
  return family.storage_class === "operational-log" || family.storage_class === "debug-log";
}
function integer(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`invalid positive integer: ${value}`);
  return parsed;
}
function queryFrom(options: QueryOptions) {
  return {
    ...(options.family ? { family_ids: options.family } : {}),
    ...(options.level ? { minimum_level: options.level } : {}),
    ...(options.event ? { event: options.event } : {}),
    ...(options.since ? { since: options.since } : {}),
    ...(options.until ? { until: options.until } : {}),
    max_records: options.maxRecords,
    max_bytes: options.maxBytes,
  };
}
async function run(emit: EmitContext, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    emit.error({
      code: "logs_query_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    emit.setExitCode(1);
  }
}
