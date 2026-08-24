import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readEventV3ControlState } from "../control.ts";
import { EVENT_V3_LEDGER_RELATIVE_ROOT } from "../reader.ts";

export interface HookProducerStateSummaryV3 {
  generation_id: `gen_${string}`;
  open_span_count: number;
  turn_open: boolean;
}

/** Read the narrow producer-state facts needed by passive coordination views. */
export function listHookProducerStateSummariesV3(coordRoot: string): HookProducerStateSummaryV3[] {
  const control = readEventV3ControlState(coordRoot);
  if (control.state !== "candidate" && control.state !== "active") return [];
  const producerRoot = join(resolve(coordRoot), EVENT_V3_LEDGER_RELATIVE_ROOT, "private-producers");
  if (!existsSync(producerRoot)) return [];
  const summaries: HookProducerStateSummaryV3[] = [];
  for (const adapter of ["claude-code", "codex", "cursor"] as const) {
    const directory = join(producerRoot, adapter);
    if (!existsSync(directory)) continue;
    const directoryMetadata = lstatSync(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      throw new Error("V3 producer state directory is unsafe");
    }
    for (const name of readdirSync(directory).filter((entry) =>
      /^hid_[a-f0-9]{64}\.json$/.test(entry),
    )) {
      const file = join(directory, name);
      const metadata = lstatSync(file);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (
        value.format !== "harnery-v3-hook-producer" ||
        value.format_version !== 3 ||
        value.adapter !== adapter ||
        value.terminal === true ||
        typeof value.generation_id !== "string" ||
        !/^gen_[a-zA-Z0-9._-]+$/.test(value.generation_id) ||
        !Array.isArray(value.spans)
      ) {
        continue;
      }
      summaries.push({
        generation_id: value.generation_id as `gen_${string}`,
        open_span_count: value.spans.length,
        turn_open: typeof value.current_turn_id === "string",
      });
    }
  }
  return summaries.sort((left, right) => left.generation_id.localeCompare(right.generation_id));
}
