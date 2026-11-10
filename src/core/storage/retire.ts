import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readlinkSync, realpathSync, rmSync, type Stats } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HarneryStorageCatalog } from "./catalog.ts";

export const HARNERY_STORAGE_RETIREMENT_SCHEMA = "harnery.storage-retirement/v1" as const;
export const HARNERY_STORAGE_RETIRED_ROOTS_SCHEMA = "harnery.storage-retired-roots/v1" as const;

/** One top-level `.harnery` folder whose feature was removed from Harnery. */
export interface HarneryRetiredRoot {
  /** The folder name directly under `.harnery`. */
  name: string;
  /** The removed feature that wrote it. */
  feature: string;
  /** The decision record that removed the feature. */
  retired_by: string;
}

/**
 * The only folders `storage retire` may remove. Being absent from the storage
 * catalog is not enough: a folder is eligible only when it is listed here with
 * the decision that retired its feature. Retirement never runs automatically.
 */
export const HARNERY_RETIRED_ROOTS: readonly HarneryRetiredRoot[] = Object.freeze([
  { name: "work", feature: "work items", retired_by: "ADR 0238" },
  { name: "governors", feature: "governors", retired_by: "ADR 0238" },
  { name: "governor-service", feature: "the governor service", retired_by: "ADR 0238" },
  { name: "councils", feature: "councils", retired_by: "ADR 0238" },
  { name: "mailbox", feature: "the council and governor mailbox", retired_by: "ADR 0238" },
]);

/** The same inspection bound `rm` applies without artifact ownership. */
export const DEFAULT_RETIREMENT_ENTRY_LIMIT = 10_000;

export interface HarneryRetirementLink {
  /** Path relative to the retired folder. */
  path: string;
  /** What the link points to. It is removed as a link and never followed. */
  target: string;
}

export interface HarneryStorageRetirementReport {
  schema: typeof HARNERY_STORAGE_RETIREMENT_SCHEMA;
  name: string;
  feature: string;
  retired_by: string;
  path: string;
  outcome: "preview" | "retired" | "already_retired";
  applied: boolean;
  files: number;
  directories: number;
  bytes: number;
  links: readonly HarneryRetirementLink[];
  entry_limit: number;
  /** Digest of the complete inventory; `--yes` must repeat it. Absent when nothing is left. */
  inventory_sha256?: string;
}

export interface HarneryRetiredRootStatus {
  name: string;
  feature: string;
  retired_by: string;
  path: string;
  state: "present" | "absent" | "ineligible";
  files?: number;
  bytes?: number;
  reason?: string;
}

export interface HarneryRetiredRootsReport {
  schema: typeof HARNERY_STORAGE_RETIRED_ROOTS_SCHEMA;
  coord_root: string;
  roots: readonly HarneryRetiredRootStatus[];
}

export interface HarneryRetirementOptions {
  /**
   * Paths other agents currently claim, relative to the coordination root or
   * absolute. Required, so a caller cannot skip the claim check by omission;
   * throw when the claims cannot be read.
   */
  peerClaims: () => readonly string[];
  entryLimit?: number;
}

export interface HarneryRetirementExecuteOptions extends HarneryRetirementOptions {
  yes?: boolean;
  inventory_sha256?: string;
}

export class HarneryRetirementError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HarneryRetirementError";
  }
}

/** Read-only: every listed retired folder, whether it exists, and its size. */
export function listRetiredRoots(catalog: HarneryStorageCatalog): HarneryRetiredRootsReport {
  const coordRoot = catalog.context.coord_root;
  return {
    schema: HARNERY_STORAGE_RETIRED_ROOTS_SCHEMA,
    coord_root: coordRoot,
    roots: HARNERY_RETIRED_ROOTS.map((entry) => {
      const base = { ...entry, path: join(coordRoot, ".harnery", entry.name) };
      try {
        const inventory = inspect(catalog, entry.name, {
          peerClaims: () => [],
          entryLimit: DEFAULT_RETIREMENT_ENTRY_LIMIT,
        });
        if (!inventory) return { ...base, state: "absent" as const };
        return {
          ...base,
          state: "present" as const,
          files: inventory.files,
          bytes: inventory.bytes,
        };
      } catch (error) {
        return {
          ...base,
          state: "ineligible" as const,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  };
}

/** Preview one retired folder. Reads metadata only and changes nothing. */
export function previewStorageRetirement(
  catalog: HarneryStorageCatalog,
  name: string,
  options: HarneryRetirementOptions,
): HarneryStorageRetirementReport {
  const entry = retiredRoot(name);
  const limit = entryLimit(options.entryLimit);
  const inventory = inspect(catalog, entry.name, { ...options, entryLimit: limit });
  return report(catalog, entry, inventory, limit, false);
}

/**
 * Remove one retired folder after `--yes` and the digest from its preview.
 * Every check runs again, and any change since the preview refuses.
 */
export function retireStorageRoot(
  catalog: HarneryStorageCatalog,
  name: string,
  options: HarneryRetirementExecuteOptions,
): HarneryStorageRetirementReport {
  if (!options.yes) {
    if (options.inventory_sha256 !== undefined)
      throw new HarneryRetirementError(
        "confirmation_required",
        "--inventory-sha256 confirms a deletion and needs --yes; omit both to preview",
      );
    return previewStorageRetirement(catalog, name, options);
  }
  const entry = retiredRoot(name);
  const limit = entryLimit(options.entryLimit);
  const inventory = inspect(catalog, entry.name, { ...options, entryLimit: limit });
  if (!inventory) return report(catalog, entry, undefined, limit, false);
  if (!options.inventory_sha256)
    throw new HarneryRetirementError(
      "inventory_digest_required",
      `--yes needs --inventory-sha256 from a preview; preview with: storage retire ${entry.name}`,
    );
  if (options.inventory_sha256 !== inventory.sha256)
    throw new HarneryRetirementError(
      "inventory_changed",
      `${inventory.path} does not match the previewed inventory; preview it again`,
    );
  // Fresh fingerprints immediately before the only mutation. The filesystem
  // can still change after this check; this is a guard, not a transaction.
  for (const [path, previous] of inventory.snapshots)
    if (fingerprint(lstatSync(path)) !== previous)
      throw new HarneryRetirementError(
        "inventory_changed",
        `${path} changed during inspection; preview it again`,
      );
  // Links inside the folder are removed as links; their targets are untouched.
  rmSync(inventory.path, { recursive: true, force: false });
  return report(catalog, entry, inventory, limit, true);
}

interface Inventory {
  path: string;
  files: number;
  directories: number;
  bytes: number;
  links: HarneryRetirementLink[];
  snapshots: Map<string, string>;
  sha256: string;
}

function report(
  catalog: HarneryStorageCatalog,
  entry: HarneryRetiredRoot,
  inventory: Inventory | undefined,
  limit: number,
  applied: boolean,
): HarneryStorageRetirementReport {
  return {
    schema: HARNERY_STORAGE_RETIREMENT_SCHEMA,
    ...entry,
    path: inventory?.path ?? join(catalog.context.coord_root, ".harnery", entry.name),
    outcome: !inventory ? "already_retired" : applied ? "retired" : "preview",
    applied,
    files: inventory?.files ?? 0,
    directories: inventory?.directories ?? 0,
    bytes: inventory?.bytes ?? 0,
    links: inventory?.links ?? [],
    entry_limit: limit,
    ...(inventory ? { inventory_sha256: inventory.sha256 } : {}),
  };
}

function retiredRoot(name: string): HarneryRetiredRoot {
  if (typeof name !== "string" || !name)
    throw new HarneryRetirementError("not_a_retired_root", "name one retired folder");
  if (isAbsolute(name) || /[\\/]/.test(name) || name === "." || name === "..")
    throw new HarneryRetirementError(
      "not_a_retired_root",
      `name a retired folder, not a path: ${name}`,
    );
  const entry = HARNERY_RETIRED_ROOTS.find((root) => root.name === name);
  if (!entry)
    throw new HarneryRetirementError(
      "not_a_retired_root",
      `${name} is not a retired folder; retired folders: ${HARNERY_RETIRED_ROOTS.map((root) => root.name).join(", ")}`,
    );
  return entry;
}

function entryLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_RETIREMENT_ENTRY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_RETIREMENT_ENTRY_LIMIT)
    throw new HarneryRetirementError(
      "invalid_entry_limit",
      `the entry limit must be an integer from 1 to ${DEFAULT_RETIREMENT_ENTRY_LIMIT}`,
    );
  return limit;
}

/** Validate every guard and inventory the folder. Undefined means it is already gone. */
function inspect(
  catalog: HarneryStorageCatalog,
  name: string,
  options: HarneryRetirementOptions & { entryLimit: number },
): Inventory | undefined {
  const coordRoot = realpathSync(catalog.context.coord_root);
  const state = join(coordRoot, ".harnery");
  const stateInfo = lstatOrUndefined(state);
  if (!stateInfo) return undefined;
  if (stateInfo.isSymbolicLink() || !stateInfo.isDirectory())
    refuse("unsafe_path", `${state} must be a real directory, not a link`);
  const target = join(state, name);
  const info = lstatOrUndefined(target);
  if (!info) return undefined;
  if (info.isSymbolicLink()) refuse("unsafe_path", `${target} is a link; it is never followed`);
  if (!info.isDirectory()) refuse("special_file", `${target} is not a directory`);
  if (realpathSync(target) !== target)
    refuse("unsafe_path", `${target} does not resolve to itself`);
  if (info.dev !== stateInfo.dev) refuse("mount_boundary", `${target} is on another filesystem`);

  // Catalog roots are registered against the configured path, which may name
  // the same folder through a link (a linked temporary directory, say).
  const configured = join(resolve(catalog.context.coord_root), ".harnery", name);
  const overlaps = [
    ...catalog.rootsOverlapping(target),
    ...(configured === target ? [] : catalog.rootsOverlapping(configured)),
  ];
  if (overlaps.length)
    refuse(
      "storage_root_overlap",
      `${target} overlaps registered storage: ${overlaps.map((o) => `${o.kind} ${o.id} at ${o.root}`).join("; ")}`,
    );

  for (const claim of options.peerClaims()) {
    const claimed = resolve(coordRoot, claim);
    const overlapsClaim = (path: string) => contains(path, claimed) || contains(claimed, path);
    if (overlapsClaim(target) || overlapsClaim(configured))
      refuse("peer_claim", `${target} overlaps another agent's claim: ${claim}`);
  }

  const snapshots = new Map<string, string>();
  const records: string[] = [];
  const links: HarneryRetirementLink[] = [];
  let files = 0;
  let directories = 0;
  let bytes = 0;
  const pending = [target];
  while (pending.length) {
    const path = pending.pop()!;
    if (snapshots.size >= options.entryLimit)
      refuse(
        "entry_limit_exceeded",
        `${target} has more than ${options.entryLimit} entries; this command inspects at most that many`,
      );
    const entry = lstatSync(path);
    const rel = relative(target, path).split(sep).join("/") || ".";
    if (path !== target && basename(path).toLowerCase() === ".git")
      refuse("repository_metadata", `${path} is Git metadata; this command never removes it`);
    snapshots.set(path, fingerprint(entry));
    if (entry.isSymbolicLink()) {
      const linkTarget = readlinkSync(path);
      links.push({ path: rel, target: linkTarget });
      records.push(`l\0${rel}\0${linkTarget}\0${fingerprint(entry)}`);
      continue;
    }
    if (entry.dev !== info.dev) refuse("mount_boundary", `${path} is on another filesystem`);
    if (entry.isFile()) {
      files += 1;
      bytes += entry.size;
      records.push(`f\0${rel}\0${entry.size}\0${fingerprint(entry)}`);
    } else if (entry.isDirectory()) {
      directories += 1;
      records.push(`d\0${rel}\0${fingerprint(entry)}`);
      for (const child of readdirSync(path)) pending.push(join(path, child));
    } else {
      refuse("special_file", `${path} is not a regular file, directory or link`);
    }
  }
  assertUntracked(target);
  records.sort();
  const sha256 = createHash("sha256")
    .update(`${HARNERY_STORAGE_RETIREMENT_SCHEMA}\0${target}\0`)
    .update(records.join("\n"))
    .digest("hex");
  return { path: target, files, directories, bytes, links, snapshots, sha256 };
}

function refuse(code: string, message: string): never {
  throw new HarneryRetirementError(code, message);
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function fingerprint(stat: Stats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

/** Tracked content belongs to Git; this command never removes it. */
function assertUntracked(target: string): void {
  const git = (args: string[]) =>
    spawnSync("git", ["-C", target, ...args], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        LC_ALL: "C",
        GIT_LITERAL_PATHSPECS: "1",
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_INDEX_FILE: undefined,
      },
    });
  const detected = git(["rev-parse", "--show-toplevel"]);
  if (detected.error)
    refuse("git_unavailable", `cannot check Git ownership: ${detected.error.message}`);
  if (detected.status !== 0) {
    if (detected.stderr.startsWith("fatal: not a git repository")) return;
    refuse("git_unavailable", `cannot check Git ownership: ${detected.stderr.trim()}`);
  }
  const tracked = git(["ls-files", "--cached", "-z", "--full-name", "--", "."]);
  if (tracked.error || tracked.status !== 0)
    refuse("git_unavailable", `cannot inspect the Git index for ${target}`);
  if (tracked.stdout.length)
    refuse("tracked_content", `${target} holds files tracked by Git; use git rm for those`);
}
