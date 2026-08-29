import type { Dir, Stats } from "node:fs";
import {
  lstat as defaultLstat,
  opendir as defaultOpendir,
  realpath as defaultRealpath,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HarneryStorageCatalog } from "./catalog.ts";
import {
  HARNERY_STORAGE_INVENTORY_SCHEMA,
  type HarneryRegisteredStorageFamily,
  type HarneryStorageClass,
  type HarneryStorageFamilyInventory,
  type HarneryStorageInventoryReport,
  type HarneryStorageInventoryTotals,
  type HarneryStorageIssueSummary,
  type HarneryStorageMeasurement,
  type HarneryStorageReasonCode,
  type HarneryStorageRoot,
  type HarneryStorageRootInventory,
} from "./contract.ts";

const MAX_CONCURRENCY = 16;

export interface HarneryStorageInventoryOptions {
  now?: () => Date;
  allocatedBytes?: (stats: Stats) => number | undefined;
  fs?: Partial<HarneryStorageInventoryFs>;
}

export interface HarneryStorageInventoryFs {
  lstat(path: string): Promise<Stats>;
  opendir(path: string): Promise<Dir>;
  realpath(path: string): Promise<string>;
}

export interface HarneryStorageInventoryFilter {
  family_id?: string;
  storage_class?: HarneryStorageClass;
}

interface MutableTotals {
  regular_files: number;
  logical_bytes: number;
  allocated_bytes: number;
  allocated_available: boolean;
}

interface RootAccumulator {
  root: HarneryStorageRoot;
  index: number;
  base_present: boolean;
  matched: boolean;
  totals: MutableTotals;
  reasons: Set<HarneryStorageReasonCode>;
}

interface FamilyAccumulator {
  family: HarneryRegisteredStorageFamily;
  roots: RootAccumulator[];
  totals: MutableTotals;
  reasons: Set<HarneryStorageReasonCode>;
}

interface ScanState {
  catalog: HarneryStorageCatalog;
  coordStorageRoot: string;
  families: Map<string, FamilyAccumulator>;
  totals: MutableTotals;
  coordinationRootTotals: MutableTotals;
  externalRootTotals: MutableTotals;
  issues: Map<HarneryStorageReasonCode, number>;
  allocatedBytes: (stats: Stats) => number | undefined;
  fs: HarneryStorageInventoryFs;
}

interface ScanPath {
  physical: string;
  logical: string;
  expectedIdentity?: FileIdentity;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

/**
 * Inventory registered storage with metadata-only, depth-first traversal.
 * The complete `.harnery` root is scanned once; outside it, only explicit
 * registered filesystem roots are visited.
 */
export async function inventoryStorage(
  catalog: HarneryStorageCatalog,
  options: HarneryStorageInventoryOptions = {},
): Promise<HarneryStorageInventoryReport> {
  const coordStorageRoot = resolve(catalog.context.coord_root, ".harnery");
  const state: ScanState = {
    catalog,
    coordStorageRoot,
    families: new Map(
      catalog.families.map((family) => [
        family.id,
        {
          family,
          roots: family.resolved_roots.map((root, index) => ({
            root,
            index,
            base_present: false,
            matched: false,
            totals: emptyTotals(),
            reasons: new Set(),
          })),
          totals: emptyTotals(),
          reasons: new Set(),
        },
      ]),
    ),
    totals: emptyTotals(),
    coordinationRootTotals: emptyTotals(),
    externalRootTotals: emptyTotals(),
    issues: new Map(),
    allocatedBytes: options.allocatedBytes ?? allocatedBytes,
    fs: {
      lstat: options.fs?.lstat ?? defaultLstat,
      opendir: options.fs?.opendir ?? defaultOpendir,
      realpath: options.fs?.realpath ?? defaultRealpath,
    },
  };

  await inspectRegisteredRoots(state);
  await scanBoundary(state, coordStorageRoot, true);
  for (const boundary of externalBoundaries(state)) {
    await scanBoundary(state, boundary, false);
  }

  return {
    schema: HARNERY_STORAGE_INVENTORY_SCHEMA,
    captured_at: (options.now ?? (() => new Date()))().toISOString(),
    privacy: { content_read: false, path_mode: "aggregate-labels" },
    scan: {
      mode: "streaming-lstat",
      max_concurrency: MAX_CONCURRENCY,
      project_filesystem_scope: ".harnery-and-registered-external-roots",
    },
    filter: {},
    filesystem_totals: observedTotals(state.totals),
    scope_totals: {
      coordination_root: observedTotals(state.coordinationRootTotals),
      registered_external_roots: observedTotals(state.externalRootTotals),
    },
    families: [...state.families.values()]
      .map((family) => familyInventory(catalog, family))
      .sort((left, right) => left.family_id.localeCompare(right.family_id)),
    issues: issueRows(state.issues),
  };
}

export function filterStorageInventory(
  report: HarneryStorageInventoryReport,
  filter: HarneryStorageInventoryFilter,
): HarneryStorageInventoryReport {
  return {
    ...report,
    filter: {
      ...(filter.family_id ? { family_id: filter.family_id } : {}),
      ...(filter.storage_class ? { storage_class: filter.storage_class } : {}),
    },
    families: report.families.filter(
      (family) =>
        (!filter.family_id || family.family_id === filter.family_id) &&
        (!filter.storage_class || family.storage_class === filter.storage_class),
    ),
  };
}

function emptyTotals(): MutableTotals {
  return { regular_files: 0, logical_bytes: 0, allocated_bytes: 0, allocated_available: true };
}

async function inspectRegisteredRoots(state: ScanState): Promise<void> {
  for (const family of state.families.values()) {
    if (family.family.provider.inventory === "delegated") {
      family.reasons.add("delegated_inventory_unavailable");
      for (const root of family.roots) root.reasons.add("delegated_inventory_unavailable");
      continue;
    }
    for (const root of family.roots) {
      let metadata: Stats;
      try {
        metadata = await state.fs.lstat(root.root.path);
      } catch (error) {
        if (isMissing(error)) root.reasons.add("root_dormant");
        else root.reasons.add("unreadable_path");
        continue;
      }
      if (metadata.isSymbolicLink()) {
        root.reasons.add("symlink_rejected");
        continue;
      }
      const expectedDirectory = root.root.kind === "directory";
      if (
        (expectedDirectory && !metadata.isDirectory()) ||
        (!expectedDirectory && !metadata.isFile())
      ) {
        root.reasons.add("wrong_root_type");
        continue;
      }
      root.base_present = true;
    }
  }
}

function externalBoundaries(state: ScanState): string[] {
  const boundaries = new Set<string>();
  for (const family of state.families.values()) {
    if (family.family.provider.inventory !== "filesystem") continue;
    for (const { root } of family.roots) {
      if (!within(state.coordStorageRoot, root.path)) boundaries.add(resolve(root.path));
    }
  }
  const ordered = [...boundaries].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  const collapsed: string[] = [];
  for (const boundary of ordered) {
    if (!collapsed.some((parent) => within(parent, boundary))) collapsed.push(boundary);
  }
  return collapsed;
}

async function scanBoundary(
  state: ScanState,
  boundary: string,
  completeCoordinationRoot: boolean,
): Promise<void> {
  let metadata: Stats;
  try {
    metadata = await state.fs.lstat(boundary);
  } catch (error) {
    if (!isMissing(error)) recordIssue(state, "unreadable_path");
    return;
  }
  if (metadata.isSymbolicLink()) {
    recordBoundaryIssue(state, boundary, "symlink_rejected", completeCoordinationRoot);
    return;
  }
  if (!metadata.isFile() && !metadata.isDirectory()) {
    recordBoundaryIssue(state, boundary, "special_file_rejected", completeCoordinationRoot);
    return;
  }
  let safeRoot: string;
  try {
    safeRoot = await state.fs.realpath(boundary);
  } catch {
    recordBoundaryIssue(state, boundary, "unreadable_path", completeCoordinationRoot);
    return;
  }
  let targetMetadata: Stats;
  try {
    targetMetadata = await state.fs.lstat(safeRoot);
  } catch {
    recordBoundaryIssue(state, boundary, "unreadable_path", completeCoordinationRoot);
    return;
  }
  if (
    !sameIdentity(metadata, targetMetadata) ||
    metadata.isDirectory() !== targetMetadata.isDirectory() ||
    metadata.isFile() !== targetMetadata.isFile()
  ) {
    recordBoundaryIssue(state, boundary, "symlink_rejected", completeCoordinationRoot);
    return;
  }
  if (metadata.isFile()) {
    await recordRegularFile(
      state,
      safeRoot,
      boundary,
      metadata,
      completeCoordinationRoot,
      safeRoot,
    );
    return;
  }
  await scanDirectoryTree(state, safeRoot, boundary, metadata, completeCoordinationRoot);
}

async function scanDirectoryTree(
  state: ScanState,
  safeRoot: string,
  logicalRoot: string,
  rootMetadata: Stats,
  completeCoordinationRoot: boolean,
): Promise<void> {
  const queue: ScanPath[] = [
    {
      physical: safeRoot,
      logical: logicalRoot,
      expectedIdentity: fileIdentity(rootMetadata),
    },
  ];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    const children = await scanDirectory(
      state,
      current.physical,
      current.logical,
      current.expectedIdentity,
      safeRoot,
      completeCoordinationRoot,
    );
    queue.push(...children);
  }
}

async function scanDirectory(
  state: ScanState,
  directoryPath: string,
  logicalDirectoryPath: string,
  expectedIdentity: FileIdentity | undefined,
  safeRoot: string,
  completeCoordinationRoot: boolean,
): Promise<ScanPath[]> {
  let metadata: Stats;
  try {
    metadata = await state.fs.lstat(directoryPath);
  } catch {
    recordPathIssue(state, logicalDirectoryPath, "unreadable_path", completeCoordinationRoot);
    return [];
  }
  if (metadata.isSymbolicLink()) {
    recordPathIssue(state, logicalDirectoryPath, "symlink_rejected", completeCoordinationRoot);
    return [];
  }
  if (expectedIdentity && !matchesIdentity(metadata, expectedIdentity)) {
    recordPathIssue(state, logicalDirectoryPath, "symlink_rejected", completeCoordinationRoot);
    return [];
  }
  if (!metadata.isDirectory()) {
    recordPathIssue(state, logicalDirectoryPath, "wrong_root_type", completeCoordinationRoot);
    return [];
  }
  let canonical: string;
  try {
    canonical = await state.fs.realpath(directoryPath);
  } catch {
    recordPathIssue(state, logicalDirectoryPath, "unreadable_path", completeCoordinationRoot);
    return [];
  }
  if (!within(safeRoot, canonical)) {
    recordPathIssue(state, logicalDirectoryPath, "symlink_rejected", completeCoordinationRoot);
    return [];
  }
  let canonicalMetadata: Stats;
  try {
    canonicalMetadata = await state.fs.lstat(canonical);
  } catch {
    recordPathIssue(state, logicalDirectoryPath, "unreadable_path", completeCoordinationRoot);
    return [];
  }
  if (!canonicalMetadata.isDirectory() || !sameIdentity(metadata, canonicalMetadata)) {
    recordPathIssue(state, logicalDirectoryPath, "symlink_rejected", completeCoordinationRoot);
    return [];
  }
  let directory: Dir;
  try {
    directory = await state.fs.opendir(canonical);
  } catch {
    recordPathIssue(state, logicalDirectoryPath, "unreadable_path", completeCoordinationRoot);
    return [];
  }
  try {
    const [revalidatedPath, revalidatedCanonical] = await Promise.all([
      state.fs.lstat(directoryPath),
      state.fs.lstat(canonical),
    ]);
    if (
      revalidatedPath.isSymbolicLink() ||
      !sameIdentity(metadata, revalidatedPath) ||
      !sameIdentity(metadata, revalidatedCanonical)
    ) {
      await closeRejectedDirectory(directory);
      recordPathIssue(state, logicalDirectoryPath, "symlink_rejected", completeCoordinationRoot);
      return [];
    }
  } catch {
    await closeRejectedDirectory(directory);
    recordPathIssue(state, logicalDirectoryPath, "unreadable_path", completeCoordinationRoot);
    return [];
  }
  const childDirectories: ScanPath[] = [];
  let batch: ScanPath[] = [];
  for await (const entry of directory) {
    batch.push({
      physical: join(canonical, entry.name),
      logical: join(logicalDirectoryPath, entry.name),
    });
    if (batch.length === MAX_CONCURRENCY) {
      childDirectories.push(
        ...(await scanEntryBatch(state, batch, safeRoot, completeCoordinationRoot)),
      );
      batch = [];
    }
  }
  if (batch.length > 0) {
    childDirectories.push(
      ...(await scanEntryBatch(state, batch, safeRoot, completeCoordinationRoot)),
    );
  }
  return childDirectories;
}

async function scanEntryBatch(
  state: ScanState,
  paths: readonly ScanPath[],
  safeRoot: string,
  completeCoordinationRoot: boolean,
): Promise<ScanPath[]> {
  const children = await Promise.all(
    paths.map((path) => scanEntry(state, path, safeRoot, completeCoordinationRoot)),
  );
  return children.filter((path): path is ScanPath => path !== undefined);
}

async function scanEntry(
  state: ScanState,
  path: ScanPath,
  safeRoot: string,
  completeCoordinationRoot: boolean,
): Promise<ScanPath | undefined> {
  let child: Stats;
  try {
    child = await state.fs.lstat(path.physical);
  } catch {
    recordPathIssue(state, path.logical, "unreadable_path", completeCoordinationRoot);
    return undefined;
  }
  if (child.isSymbolicLink()) {
    recordPathIssue(state, path.logical, "symlink_rejected", completeCoordinationRoot);
  } else if (child.isDirectory()) {
    return { ...path, expectedIdentity: fileIdentity(child) };
  } else if (child.isFile()) {
    await recordRegularFile(
      state,
      path.physical,
      path.logical,
      child,
      completeCoordinationRoot,
      safeRoot,
    );
  } else {
    recordPathIssue(state, path.logical, "special_file_rejected", completeCoordinationRoot);
  }
  return undefined;
}

async function closeRejectedDirectory(directory: Dir): Promise<void> {
  try {
    await directory.close();
  } catch {
    // Rejection remains fail-closed even when the platform already closed it.
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fileIdentity(stats: Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function matchesIdentity(stats: Stats, identity: FileIdentity): boolean {
  return stats.dev === identity.dev && stats.ino === identity.ino;
}

async function recordRegularFile(
  state: ScanState,
  physicalPath: string,
  logicalPath: string,
  metadata: Stats,
  completeCoordinationRoot: boolean,
  safeRoot: string,
): Promise<void> {
  let canonical: string;
  let canonicalMetadata: Stats;
  try {
    canonical = await state.fs.realpath(physicalPath);
    canonicalMetadata = await state.fs.lstat(canonical);
  } catch {
    recordPathIssue(state, logicalPath, "unreadable_path", completeCoordinationRoot);
    return;
  }
  if (!within(safeRoot, canonical) || !sameIdentity(metadata, canonicalMetadata)) {
    recordPathIssue(state, logicalPath, "symlink_rejected", completeCoordinationRoot);
    return;
  }
  const matches = filesystemMatches(state, logicalPath);
  if (!completeCoordinationRoot && matches.length === 0) return;
  const hardLinkAmbiguous = metadata.nlink > 1;
  if (hardLinkAmbiguous) recordIssue(state, "hard_link_ambiguous");
  const allocatedCandidate = hardLinkAmbiguous ? undefined : state.allocatedBytes(metadata);
  const allocated =
    allocatedCandidate !== undefined &&
    Number.isSafeInteger(allocatedCandidate) &&
    allocatedCandidate >= 0
      ? allocatedCandidate
      : undefined;
  addFile(state.totals, metadata.size, allocated);
  addFile(
    completeCoordinationRoot ? state.coordinationRootTotals : state.externalRootTotals,
    metadata.size,
    allocated,
  );
  if (allocated === undefined) recordIssue(state, "allocated_bytes_unavailable");
  if (matches.length === 0) {
    const exclusion = state.catalog.exclusions.some(({ root }) => rootMatches(root, logicalPath));
    recordIssue(state, exclusion ? "host_exclusion" : "unregistered_path");
    return;
  }
  if (matches.length > 1) {
    recordIssue(state, "overlapping_registration");
    for (const match of matches) match.reasons.add("overlapping_registration");
    return;
  }
  const family = matches[0]!;
  const roots = family.roots.filter(({ root }) => rootMatches(root, logicalPath));
  if (roots.length !== 1) {
    recordIssue(state, "overlapping_registration");
    family.reasons.add("overlapping_registration");
    return;
  }
  addFile(family.totals, metadata.size, allocated);
  family.roots[roots[0]!.index]!.matched = true;
  addFile(family.roots[roots[0]!.index]!.totals, metadata.size, allocated);
  if (hardLinkAmbiguous) {
    family.reasons.add("hard_link_ambiguous");
    family.roots[roots[0]!.index]!.reasons.add("hard_link_ambiguous");
  }
  if (allocated === undefined) {
    family.reasons.add("allocated_bytes_unavailable");
    family.roots[roots[0]!.index]!.reasons.add("allocated_bytes_unavailable");
  }
}

function recordPathIssue(
  state: ScanState,
  path: string,
  reason: HarneryStorageReasonCode,
  completeCoordinationRoot: boolean,
): void {
  const matches = filesystemMatches(state, path);
  if (!completeCoordinationRoot && matches.length === 0) return;
  recordIssue(state, reason);
  if (matches.length === 0 && completeCoordinationRoot) recordIssue(state, "unregistered_path");
  for (const family of matches) {
    family.reasons.add(reason);
    for (const root of family.roots.filter(({ root }) => rootMatches(root, path))) {
      root.reasons.add(reason);
    }
  }
}

function recordBoundaryIssue(
  state: ScanState,
  path: string,
  reason: HarneryStorageReasonCode,
  completeCoordinationRoot: boolean,
): void {
  const resolved = resolve(path);
  const matches = [...state.families.values()].filter(
    (family) =>
      family.family.provider.inventory === "filesystem" &&
      family.roots.some(({ root }) => resolve(root.path) === resolved),
  );
  recordIssue(state, reason);
  if (matches.length === 0 && completeCoordinationRoot) recordIssue(state, "unregistered_path");
  for (const family of matches) {
    family.reasons.add(reason);
    for (const root of family.roots.filter(({ root }) => resolve(root.path) === resolved)) {
      root.reasons.add(reason);
    }
  }
}

function filesystemMatches(state: ScanState, path: string): FamilyAccumulator[] {
  return state.catalog
    .familiesForPath(path)
    .filter((family) => family.provider.inventory === "filesystem")
    .map((family) => state.families.get(family.id)!);
}

function addFile(totals: MutableTotals, logicalBytes: number, allocated: number | undefined): void {
  totals.regular_files += 1;
  totals.logical_bytes += logicalBytes;
  if (allocated === undefined || !Number.isSafeInteger(allocated) || allocated < 0) {
    totals.allocated_available = false;
  } else totals.allocated_bytes += allocated;
}

function allocatedBytes(stats: Stats): number | undefined {
  if (typeof stats.blocks !== "number" || !Number.isSafeInteger(stats.blocks)) return undefined;
  const bytes = stats.blocks * 512;
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

function recordIssue(state: ScanState, reason: HarneryStorageReasonCode): void {
  state.issues.set(reason, (state.issues.get(reason) ?? 0) + 1);
}

function familyInventory(
  catalog: HarneryStorageCatalog,
  accumulator: FamilyAccumulator,
): HarneryStorageFamilyInventory {
  const delegated = accumulator.family.provider.inventory === "delegated";
  const roots = accumulator.roots.map((root) => rootInventory(catalog, accumulator, root));
  const rootStates = new Set(roots.map(({ state }) => state));
  const reasons = new Set(accumulator.reasons);
  for (const root of roots) for (const reason of root.reason_codes) reasons.add(reason);
  let state: HarneryStorageFamilyInventory["state"];
  if (delegated) state = "delegated";
  else if (rootStates.has("unavailable") && rootStates.size === 1) state = "unavailable";
  else if (rootStates.has("unavailable") || rootStates.has("partial")) state = "partial";
  else if (rootStates.has("present") && rootStates.has("dormant")) state = "partial";
  else if (rootStates.has("present")) state = "present";
  else state = "dormant";
  if (state === "dormant" || rootStates.has("dormant")) reasons.add("root_dormant");
  return {
    family_id: accumulator.family.id,
    source: accumulator.family.source,
    storage_class: accumulator.family.storage_class,
    policy_version: accumulator.family.policy.policy_version,
    provider_id: accumulator.family.provider.provider_id,
    inventory: accumulator.family.provider.inventory,
    maintenance: maintenance(accumulator.family, state, reasons),
    state,
    reason_codes: [...reasons].sort(),
    totals: delegated
      ? unavailableTotals("delegated_inventory_unavailable")
      : observedTotals(accumulator.totals),
    roots,
  };
}

function rootInventory(
  catalog: HarneryStorageCatalog,
  family: FamilyAccumulator,
  root: RootAccumulator,
): HarneryStorageRootInventory {
  const delegated = family.family.provider.inventory === "delegated";
  const reasons = new Set(root.reasons);
  let state: HarneryStorageRootInventory["state"];
  if (delegated) state = "delegated";
  else if (reasons.has("unreadable_path") || reasons.has("wrong_root_type")) state = "unavailable";
  else if (reasons.has("symlink_rejected")) state = "unavailable";
  else if (root.matched || (root.base_present && root.root.match === "subtree")) state = "present";
  else if (root.base_present && root.root.match === "exact" && root.root.kind === "directory") {
    state = "present";
  } else {
    state = "dormant";
    reasons.add("root_dormant");
  }
  return {
    root_index: root.index,
    root_label: rootLabel(catalog, family.family.id, root),
    ownership: root.root.ownership ?? "harnery",
    state,
    reason_codes: [...reasons].sort(),
    totals: delegated
      ? unavailableTotals("delegated_inventory_unavailable")
      : observedTotals(root.totals),
  };
}

function rootLabel(
  catalog: HarneryStorageCatalog,
  familyId: string,
  root: RootAccumulator,
): string {
  const rel = relative(catalog.context.coord_root, root.root.path);
  if (rel === "") return ".";
  if (!rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
  return `<external:${familyId}:${root.index + 1}>`;
}

function maintenance(
  family: HarneryRegisteredStorageFamily,
  state: HarneryStorageFamilyInventory["state"],
  reasons: Set<HarneryStorageReasonCode>,
): HarneryStorageFamilyInventory["maintenance"] {
  if (family.provider.maintenance === "delegated") {
    return { state: "delegated", reason_code: "maintenance_delegated" };
  }
  if (family.provider.maintenance === "none") {
    return { state: "ineligible", reason_code: "maintenance_not_registered" };
  }
  if (family.policy.retention.status !== "active") {
    return { state: "ineligible", reason_code: "maintenance_policy_inactive" };
  }
  if (state !== "present" || reasons.has("allocated_bytes_unavailable")) {
    return { state: "ineligible", reason_code: "provider_unavailable" };
  }
  if (
    [...reasons].some((reason) =>
      [
        "host_exclusion",
        "hard_link_ambiguous",
        "overlapping_registration",
        "special_file_rejected",
        "symlink_rejected",
        "unreadable_path",
        "unregistered_path",
        "wrong_root_type",
      ].includes(reason),
    )
  ) {
    return { state: "ineligible", reason_code: "provider_unavailable" };
  }
  return { state: "eligible" };
}

function observedTotals(totals: MutableTotals): HarneryStorageInventoryTotals {
  return {
    regular_files: observed("files", totals.regular_files),
    logical_bytes: observed("bytes", totals.logical_bytes),
    allocated_bytes: totals.allocated_available
      ? observed("bytes", totals.allocated_bytes)
      : unavailable("bytes", "allocated_bytes_unavailable"),
  };
}

function unavailableTotals(reason: HarneryStorageReasonCode): HarneryStorageInventoryTotals {
  return {
    regular_files: unavailable("files", reason),
    logical_bytes: unavailable("bytes", reason),
    allocated_bytes: unavailable("bytes", reason),
  };
}

function observed(unit: "files" | "bytes", value: number): HarneryStorageMeasurement {
  return { state: "observed", unit, value };
}

function unavailable(
  unit: "files" | "bytes",
  reason_code: HarneryStorageReasonCode,
): HarneryStorageMeasurement {
  return { state: "unavailable", unit, reason_code };
}

function issueRows(issues: Map<HarneryStorageReasonCode, number>): HarneryStorageIssueSummary[] {
  return [...issues.entries()]
    .map(([reason_code, count]) => ({ reason_code, count, maintenance_eligible: false as const }))
    .sort((left, right) => left.reason_code.localeCompare(right.reason_code));
}

function rootMatches(root: HarneryStorageRoot, candidate: string): boolean {
  const path = resolve(candidate);
  if (root.match === "exact") return resolve(root.path) === path;
  const remainder = relative(root.path, path).split(sep).join("/");
  if (remainder === "" || remainder.startsWith("..") || isAbsolute(remainder)) return false;
  if (root.match === "subtree") return true;
  return root.include!.some((pattern) => globRegex(pattern).test(remainder));
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else source += "[^/]*";
    } else if (character === "?") source += "[^/]";
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function within(root: string, candidate: string): boolean {
  const remainder = relative(resolve(root), resolve(candidate));
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
