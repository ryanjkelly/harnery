import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJsonV3 } from "../canonical.ts";

/**
 * Restamp, in place, every stored event that crash recovery would resubmit
 * unchanged: a hook or command producer state's `pending.event`, a
 * coordination producer state's `pending.transaction.event_row`, and an
 * authority outbox ready transaction's `event_row`. This stands in for state an earlier runtime of
 * the same additive group left behind before an upgrade. Returns how many
 * stored events were restamped.
 */
export function restampStoredEventDigestsV3(coordRoot: string, digest: string): number {
  let restamped = 0;
  for (const path of filesUnder(join(coordRoot, ".harnery"))) {
    if (!path.endsWith(".json") && !path.endsWith(".ready")) continue;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const record = value as {
      pending?: {
        event?: { contract?: { schema_digest?: string } };
        transaction?: { event_row?: unknown };
      };
      event_row?: unknown;
    };
    if (record.pending?.event?.contract) {
      // Hook and command producer state: the pre-minted event itself.
      record.pending.event.contract.schema_digest = digest;
      writeFileSync(path, `${JSON.stringify(record)}\n`);
      restamped += 1;
    } else if (typeof record.pending?.transaction?.event_row === "string") {
      // Coordination producer state: the transaction it owns, event row included.
      record.pending.transaction.event_row = restampRow(
        record.pending.transaction.event_row,
        digest,
      );
      writeFileSync(path, `${JSON.stringify(record)}\n`);
      restamped += 1;
    } else if (typeof record.event_row === "string" && path.includes("authority-outbox")) {
      record.event_row = restampRow(record.event_row, digest);
      writeFileSync(path, `${canonicalJsonV3(record)}\n`);
      restamped += 1;
    }
  }
  return restamped;
}

function restampRow(row: string, digest: string): string {
  const event = JSON.parse(row) as { contract: { schema_digest: string } };
  event.contract.schema_digest = digest;
  return `${canonicalJsonV3(event)}\n`;
}

function filesUnder(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) return filesUnder(path);
    return stat.isFile() ? [path] : [];
  });
}
