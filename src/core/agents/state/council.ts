/**
 * Council manifest mutations: lifecycle helpers for the council-* actions.
 *
 * A council is a multi-round debate among agents recorded at
 * `.harnery/councils/<id>.json` (manifest) plus `.harnery/councils/<id>/round-N/<member>.md`
 * (contributions). Archive moves both into `.harnery/councils/archive/`.
 *
 * This module owns: lifecycle (advance, close, archive, unarchive, delete)
 * and steward reassignment. Council CREATION + contribution writes stay
 * separate (operator-side, harness-agnostic).
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

interface CouncilManifest {
  council_id: string;
  status: "active" | "closed" | "archived";
  current_round: number;
  round_status: "open" | "closed";
  members: string[];
  /** schema_version 2: index-parallel to members; contributions are written as <member_id>.md. */
  member_ids?: string[];
  steward?: string;
  steward_id?: string;
  closed_at?: string;
  archived_at?: string;
  [extra: string]: unknown;
}

function nowIsoSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function atomicWriteText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

function councilsDir(coordRoot: string): string {
  return join(coordRoot, ".harnery", "councils");
}

function archiveDir(coordRoot: string): string {
  return join(councilsDir(coordRoot), "archive");
}

function readManifest(path: string): CouncilManifest | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CouncilManifest;
  } catch {
    return null;
  }
}

export function advanceCouncil(
  coordRoot: string,
  councilId: string,
  opts: { force?: boolean } = {},
): { ok: boolean; reason?: string; pendingMember?: string } {
  const manifestPath = join(councilsDir(coordRoot), `${councilId}.json`);
  const manifest = readManifest(manifestPath);
  if (!manifest) return { ok: false, reason: `no manifest at ${manifestPath}` };
  if (manifest.status !== "active") {
    return { ok: false, reason: `council is ${manifest.status}, not active` };
  }
  const cur = manifest.current_round;

  if (!opts.force) {
    const roundDir = join(councilsDir(coordRoot), councilId, `round-${cur}`);
    const memberIds = Array.isArray(manifest.member_ids) ? manifest.member_ids : [];
    for (const [i, member] of manifest.members.entries()) {
      // Contribution filename drifted across schema versions: v1 wrote
      // <agent-Name>.md, v2 (member_ids in the manifest) writes <uuid>.md.
      // Accept either so lifecycle works on both generations of council.
      const candidates = [join(roundDir, `${member}.md`)];
      if (memberIds[i]) candidates.push(join(roundDir, `${memberIds[i]}.md`));
      if (!candidates.some((p) => existsSync(p))) {
        return {
          ok: false,
          reason: `pending members in round ${cur} (incl. ${member}); pass --force to skip`,
          pendingMember: member,
        };
      }
    }
  }

  const next = cur + 1;
  const nextDir = join(councilsDir(coordRoot), councilId, `round-${next}`);
  mkdirSync(nextDir, { recursive: true });

  const updated: CouncilManifest = {
    ...manifest,
    current_round: next,
    round_status: "open",
  };
  atomicWriteText(manifestPath, JSON.stringify(updated, null, 2));
  return { ok: true };
}

export function closeCouncil(
  coordRoot: string,
  councilId: string,
): { ok: boolean; reason?: string } {
  const manifestPath = join(councilsDir(coordRoot), `${councilId}.json`);
  const manifest = readManifest(manifestPath);
  if (!manifest) return { ok: false, reason: `no manifest at ${manifestPath}` };
  if (manifest.status === "archived") return { ok: false, reason: "council is already archived" };

  const updated: CouncilManifest = {
    ...manifest,
    status: "closed",
    closed_at: nowIsoSeconds(),
  };
  atomicWriteText(manifestPath, JSON.stringify(updated, null, 2));
  return { ok: true };
}

export function archiveCouncil(
  coordRoot: string,
  councilId: string,
): { ok: boolean; reason?: string } {
  const manifestPath = join(councilsDir(coordRoot), `${councilId}.json`);
  const manifest = readManifest(manifestPath);
  if (!manifest) return { ok: false, reason: `no manifest at ${manifestPath}` };

  const archived: CouncilManifest = {
    ...manifest,
    status: "archived",
    archived_at: nowIsoSeconds(),
  };
  const archivedManifest = join(archiveDir(coordRoot), `${councilId}.json`);
  const archivedBody = join(archiveDir(coordRoot), councilId);
  const activeBody = join(councilsDir(coordRoot), councilId);

  mkdirSync(archiveDir(coordRoot), { recursive: true });
  atomicWriteText(manifestPath, JSON.stringify(archived, null, 2));

  try {
    renameSync(manifestPath, archivedManifest);
  } catch {
    /* idempotent; manifest may already be in archive */
  }
  if (existsSync(activeBody)) {
    if (existsSync(archivedBody)) {
      rmSync(activeBody, { recursive: true, force: true });
    } else {
      try {
        renameSync(activeBody, archivedBody);
      } catch {
        // cross-device or permissions: fall back to copy + remove.
        cpSync(activeBody, archivedBody, { recursive: true });
        rmSync(activeBody, { recursive: true, force: true });
      }
    }
  }
  return { ok: true };
}

export function unarchiveCouncil(
  coordRoot: string,
  councilId: string,
): { ok: boolean; reason?: string } {
  const archivedManifest = join(archiveDir(coordRoot), `${councilId}.json`);
  const activeManifest = join(councilsDir(coordRoot), `${councilId}.json`);
  if (!existsSync(archivedManifest)) {
    return { ok: false, reason: `no archived manifest at ${archivedManifest}` };
  }
  if (existsSync(activeManifest)) {
    return { ok: false, reason: "active manifest already exists; refusing to clobber" };
  }
  const manifest = readManifest(archivedManifest);
  if (!manifest) return { ok: false, reason: `couldn't parse ${archivedManifest}` };

  const restored: CouncilManifest = { ...manifest };
  restored.archived_at = undefined;
  restored.status = manifest.closed_at ? "closed" : "active";
  atomicWriteText(archivedManifest, JSON.stringify(restored, null, 2));

  try {
    renameSync(archivedManifest, activeManifest);
  } catch {
    /* ignore; idempotent */
  }
  const archivedBody = join(archiveDir(coordRoot), councilId);
  const activeBody = join(councilsDir(coordRoot), councilId);
  if (existsSync(archivedBody)) {
    if (existsSync(activeBody)) {
      rmSync(archivedBody, { recursive: true, force: true });
    } else {
      try {
        renameSync(archivedBody, activeBody);
      } catch {
        cpSync(archivedBody, activeBody, { recursive: true });
        rmSync(archivedBody, { recursive: true, force: true });
      }
    }
  }
  return { ok: true };
}

export function deleteCouncil(
  coordRoot: string,
  councilId: string,
): { ok: boolean; reason?: string } {
  const archivedManifest = join(archiveDir(coordRoot), `${councilId}.json`);
  const activeManifest = join(councilsDir(coordRoot), `${councilId}.json`);
  if (existsSync(activeManifest)) {
    return {
      ok: false,
      reason: `council ${councilId} is not archived; archive first`,
    };
  }
  if (!existsSync(archivedManifest)) {
    return { ok: false, reason: `no archived manifest at ${archivedManifest}` };
  }
  const archivedBody = join(archiveDir(coordRoot), councilId);

  rmSync(archivedManifest, { force: true });
  if (existsSync(archivedBody)) {
    rmSync(archivedBody, { recursive: true, force: true });
  }
  return { ok: true };
}

export function setCouncilSteward(
  coordRoot: string,
  councilId: string,
  newSteward: string,
  newStewardId: string,
): { ok: boolean; reason?: string } {
  const manifestPath = join(councilsDir(coordRoot), `${councilId}.json`);
  const manifest = readManifest(manifestPath);
  if (!manifest) return { ok: false, reason: `no manifest at ${manifestPath}` };
  if (manifest.status === "archived") {
    return { ok: false, reason: "council is archived (read-only)" };
  }
  if (newSteward && !/^agent-[A-Za-z][A-Za-z0-9_-]*$/.test(newSteward)) {
    return {
      ok: false,
      reason: `invalid steward "${newSteward}" (must match agent-[A-Za-z][A-Za-z0-9_-]*)`,
    };
  }
  const updated: CouncilManifest = { ...manifest };
  if (!newSteward) {
    updated.steward = undefined;
    updated.steward_id = undefined;
  } else {
    updated.steward = newSteward;
    if (newStewardId) updated.steward_id = newStewardId;
  }
  atomicWriteText(manifestPath, JSON.stringify(updated, null, 2));
  return { ok: true };
}
