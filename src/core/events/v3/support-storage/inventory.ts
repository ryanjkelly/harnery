import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
  classifyEventV3Support,
  type EventV3SupportClassificationEvidence,
  type EventV3SupportDisposition,
} from "./classify.ts";
import type { EventV3SupportFamily } from "./pack-contract.ts";

export interface EventV3SupportAuthorityIdentity {
  state: "active" | "archived";
  epoch_directory?: string;
  genesis_id?: string;
  recovery_receipt_id?: string;
}

export interface EventV3SupportInventoryEntry {
  authority: EventV3SupportAuthorityIdentity;
  family: EventV3SupportFamily;
  relative_path: string;
  bytes: number;
  digest: `sha256:${string}`;
  disposition: EventV3SupportDisposition;
  reasons: string[];
  observed: {
    recorded_at?: string;
    modified_at: string;
  };
}

export interface InventoryEventV3SupportInput {
  authority_root: string;
  authority: EventV3SupportAuthorityIdentity;
  now: string;
  evidence?: Record<
    string,
    Omit<EventV3SupportClassificationEvidence, "family" | "authority_state" | "now">
  >;
}

const SUPPORT_ROOTS: Array<{ prefix: string; family: EventV3SupportFamily }> = [
  { prefix: "diagnostics", family: "diagnostic" },
  { prefix: "private-producers/session-tee", family: "session-tee" },
  { prefix: "authority-outbox", family: "authority-residue" },
];

/** Enumerate only V3 support roots, never canonical streams and never symlink targets. */
export async function inventoryEventV3Support(
  input: InventoryEventV3SupportInput,
): Promise<EventV3SupportInventoryEntry[]> {
  const root = resolve(input.authority_root);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("event_v3_support_inventory_authority_invalid");
  }
  const rootReal = await realpath(root);
  const results: EventV3SupportInventoryEntry[] = [];
  for (const support of SUPPORT_ROOTS) {
    const directory = join(root, ...support.prefix.split("/"));
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`event_v3_support_inventory_root_invalid:${support.prefix}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const directoryReal = await realpath(directory);
    if (relative(rootReal, directoryReal).startsWith("..")) {
      throw new Error("event_v3_support_inventory_root_escape");
    }
    await visit(directory, support.prefix, support.family);
  }
  return results.sort((left, right) => left.relative_path.localeCompare(right.relative_path));

  async function visit(
    directory: string,
    prefix: string,
    defaultFamily: EventV3SupportFamily,
  ): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      const relativePath = `${prefix}/${entry.name}`;
      const fileStat = await lstat(path);
      if (fileStat.isSymbolicLink()) throw new Error("event_v3_support_inventory_symlink");
      if (fileStat.isDirectory()) {
        await visit(path, relativePath, defaultFamily);
        continue;
      }
      if (!fileStat.isFile()) throw new Error("event_v3_support_inventory_special_file");
      const family = familyFor(relativePath, defaultFamily);
      const supplied = input.evidence?.[relativePath] ?? {};
      const classification = classifyEventV3Support({
        ...supplied,
        family,
        authority_state: input.authority.state,
        now: input.now,
        file_regular: true,
        file_owner_only: (fileStat.mode & 0o077) === 0,
      });
      results.push({
        authority: input.authority,
        family,
        relative_path: relativePath,
        bytes: fileStat.size,
        digest: await hashFile(path),
        disposition: classification.disposition,
        reasons: classification.reasons,
        observed: {
          ...(supplied.recorded_at ? { recorded_at: supplied.recorded_at } : {}),
          modified_at: fileStat.mtime.toISOString(),
        },
      });
    }
  }
}

function familyFor(path: string, fallback: EventV3SupportFamily): EventV3SupportFamily {
  if (fallback !== "authority-residue") return fallback;
  const name = basename(path);
  if (name.endsWith(".ready.json")) return "authority-ready";
  if (name.endsWith(".committed.json")) return "authority-committed";
  return fallback;
}

async function hashFile(path: string): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  for await (const current of createReadStream(path)) hash.update(current as Buffer);
  return `sha256:${hash.digest("hex")}`;
}
