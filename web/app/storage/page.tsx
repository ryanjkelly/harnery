import {
  Activity,
  Archive,
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleGauge,
  FileStack,
  FolderTree,
  Gauge,
  HardDrive,
  Info,
  Layers3,
  ListTree,
  PieChart,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import { FormattedDateTime } from "@/components/FormattedDateTime";
import { NavBar } from "@/components/NavBar";
import { StorageHelp } from "@/components/storage/StorageHelp";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { coordRoot } from "@/lib/coord-reader";
import {
  formatReasonLabel,
  formatStorageBytes,
  storageByteHelp,
  storageClassHelp,
  storageReasonHelp,
  storageStateHelp,
  storageTermHelp,
} from "@/lib/storage-display";
import type { StorageClassSummary, StorageFamilyView } from "@/lib/storage-reader";
import { readStorageFootprint } from "@/lib/storage-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Storage · Harnery" };

const CLASS_LABELS: Record<string, string> = {
  "canonical-authority": "Canonical authority",
  "recovery-state": "Recovery state",
  "durable-object-history": "Durable history",
  "operational-log": "Operational logs",
  "debug-log": "Debug logs",
  "repairable-cache": "Repairable cache",
  "managed-artifact": "Managed artifacts",
};

const CLASS_BAR: Record<string, string> = {
  "canonical-authority": "bg-sky-500",
  "recovery-state": "bg-purple-500",
  "durable-object-history": "bg-indigo-500",
  "operational-log": "bg-emerald-500",
  "debug-log": "bg-amber-500",
  "repairable-cache": "bg-zinc-500",
  "managed-artifact": "bg-cyan-500",
};

const CLASS_COLOR: Record<string, string> = {
  "canonical-authority": "#0ea5e9",
  "recovery-state": "#a855f7",
  "durable-object-history": "#6366f1",
  "operational-log": "#10b981",
  "debug-log": "#f59e0b",
  "repairable-cache": "#71717a",
  "managed-artifact": "#06b6d4",
};

export default async function StoragePage() {
  const root = coordRoot();
  const report = await readStorageFootprint(root);
  const filesystemBytes = observed(report.inventory.filesystem_totals.logical_bytes);
  const allocatedBytes = observed(report.inventory.filesystem_totals.allocated_bytes);
  const files = observed(report.inventory.filesystem_totals.regular_files);
  const logFamilies = report.families.filter(({ inventory }) => inventory.log_storage);
  const classRows = report.classes
    .map((row) => ({ row, bytes: observed(row.totals.logical_bytes) ?? 0 }))
    .sort((a, b) => b.bytes - a.bytes);
  const dominantClass = classRows[0] ?? null;
  const dominantPercent =
    dominantClass && filesystemBytes ? (dominantClass.bytes / filesystemBytes) * 100 : 0;
  const topFamilies = report.families
    .map((family) => ({
      family,
      bytes: observed(family.inventory.totals.logical_bytes) ?? 0,
    }))
    .filter(({ bytes }) => bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 6);
  const healthyFamilies = report.families.filter(
    ({ health }) => health.status === "healthy",
  ).length;
  const degradedFamilies = report.families.filter(
    ({ health }) => health.status === "degraded",
  ).length;
  const unknownFamilies = report.families.length - healthyFamilies - degradedFamilies;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <NavBar scannedDir={root} />
      <main id="storage-footprint" className="mx-auto max-w-screen-2xl px-4 pb-12 sm:px-6">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                <Term term="Storage footprint" />
              </h1>
              <HealthBadge status={report.health.status} />
            </div>
            <p className="text-sm text-muted-foreground">
              <Term term="Metadata only">Metadata-only</Term> inventory of Harnery files, external
              roots, log budgets, and maintenance boundaries.
            </p>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>
              <Term term="Captured" />{" "}
              <FormattedDateTime iso={report.inventory.captured_at} kind="datetime" />
            </div>
            <div className="mt-1">
              <StorageHelp
                name="inventory-schema"
                help="The versioned machine contract for this inventory report. It lets the CLI and dashboard reject incompatible data instead of misreading it."
              >
                <code>{report.inventory.schema}</code>
              </StorageHelp>
            </div>
          </div>
        </header>

        <section
          aria-label="Storage at a glance"
          className="storage-overview mb-6 grid gap-4 xl:grid-cols-[1.35fr_1fr]"
        >
          <Card className="relative min-h-[250px] overflow-hidden border-cyan-500/30 bg-gradient-to-br from-cyan-500/15 via-card to-sky-500/5 p-5 sm:p-6">
            <CardContent className="relative grid items-center gap-6 sm:grid-cols-[1fr_auto]">
              <div>
                <div className="mb-3 flex items-center gap-2 text-sm font-medium text-cyan-700 dark:text-cyan-300">
                  <HardDrive className="size-5" aria-hidden />
                  <Term term="Logical footprint" />
                </div>
                <div className="text-4xl font-semibold tracking-[-0.04em] tabular-nums sm:text-5xl">
                  <StorageHelp
                    name="hero-logical-footprint"
                    help={`${storageByteHelp(filesystemBytes)} This is current measured usage across all registered storage, not Harnery's maximum storage limit.`}
                    className="text-4xl sm:text-5xl"
                  >
                    <span>{formatStorageBytes(filesystemBytes)}</span>
                  </StorageHelp>
                </div>
                <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
                  {dominantClass ? (
                    <>
                      Most space is{" "}
                      <strong className="font-semibold text-foreground">
                        {classLabel(dominantClass.row.storageClass).toLowerCase()}
                      </strong>
                      , representing {formatPercent(dominantPercent)} of the measured footprint.
                    </>
                  ) : (
                    "The current inventory did not report a dominant storage class."
                  )}
                </p>
                <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <FileStack className="size-3.5" aria-hidden /> {formatCount(files)} files
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <FolderTree className="size-3.5" aria-hidden /> {report.catalog.rootCount} roots
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Layers3 className="size-3.5" aria-hidden /> {report.catalog.storageClassCount}{" "}
                    classes
                  </span>
                </div>
              </div>
              <ClassDonut rows={classRows} totalBytes={filesystemBytes ?? 0} />
            </CardContent>
          </Card>

          <div className="grid gap-3 sm:grid-cols-2">
            <SignalCard
              icon={<ShieldCheck aria-hidden />}
              label="Healthy families"
              value={healthyFamilies.toLocaleString()}
              detail={`of ${report.families.length} catalog families`}
              tone="success"
              help="Families whose inventory completed without a reported health problem."
            />
            <SignalCard
              icon={<TriangleAlert aria-hidden />}
              label="Needs attention"
              value={(degradedFamilies + unknownFamilies).toLocaleString()}
              detail={`${degradedFamilies} degraded · ${unknownFamilies} unknown`}
              tone="warning"
              help="Families whose measurement is degraded or unknown. This is a review queue, not a data-loss count."
            />
            <SignalCard
              icon={<Boxes aria-hidden />}
              label="Storage families"
              value={report.catalog.familyCount.toLocaleString()}
              detail={`${report.catalog.rootCount} roots · ${logFamilies.length} log budgets`}
              tone="sky"
              help={storageTermHelp("Storage catalog")}
            />
            <SignalCard
              icon={<CircleGauge aria-hidden />}
              label="Physical usage"
              value={allocatedBytes == null ? "Unknown" : formatStorageBytes(allocatedBytes)}
              detail={
                allocatedBytes == null ? "logical size is still measured" : "allocated on disk"
              }
              tone={allocatedBytes == null ? "muted" : "success"}
              help={
                allocatedBytes == null
                  ? storageTermHelp("Allocated bytes")
                  : storageByteHelp(allocatedBytes)
              }
            />
          </div>
        </section>

        <section
          aria-label="Storage visual summary"
          className="mb-6 grid gap-4 xl:grid-cols-[1fr_1.15fr]"
        >
          <StorageComposition rows={classRows} totalBytes={filesystemBytes ?? 0} />
          <TopFamiliesChart rows={topFamilies} totalBytes={filesystemBytes ?? 0} />
        </section>

        <IssuePanel report={report} />

        {logFamilies.length > 0 ? <LogBudgetOverview families={logFamilies} /> : null}

        <section aria-labelledby="inventory-heading" className="mb-6">
          <div className="mb-3 flex items-start gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-300">
              <ListTree className="size-5" aria-hidden />
            </div>
            <div>
              <h2 id="inventory-heading" className="text-lg font-semibold">
                Technical inventory
              </h2>
              <p className="text-sm text-muted-foreground">
                Open these only when you need the complete catalog or a specific path.
              </p>
            </div>
          </div>

          <div className="grid gap-3">
            <details
              data-storage-disclosure="families"
              className="group min-w-0 rounded-xl border border-border/60 bg-card shadow-sm"
            >
              <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 p-4 marker:hidden">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-300">
                    <Boxes className="size-5" aria-hidden />
                  </div>
                  <div className="min-w-0">
                    <h3 id="families-heading" className="font-semibold">
                      <Term term="Registered families" />
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {healthyFamilies} healthy, {degradedFamilies + unknownFamilies} to review
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium tabular-nums">
                    {report.families.length} records
                  </span>
                  <ChevronRight
                    className="size-5 text-muted-foreground group-open:hidden"
                    aria-hidden
                  />
                  <ChevronDown
                    className="hidden size-5 text-muted-foreground group-open:block"
                    aria-hidden
                  />
                </div>
              </summary>
              <div className="border-t border-border/60 p-3 sm:p-4">
                <p className="mb-3 text-xs text-muted-foreground">
                  Every family remains in the page for browser Find. Expand a row for its ownership
                  contract.
                </p>
                <div className="min-w-0 grid gap-2 md:hidden">
                  {report.families.map((family) => (
                    <FamilyMobileCard key={family.inventory.family_id} family={family} />
                  ))}
                </div>
                <div className="hidden overflow-x-auto rounded-xl border border-border/60 md:block">
                  <table className="storage-family-table min-w-[1080px] w-full table-fixed text-sm">
                    <colgroup>
                      <col className="w-[260px]" />
                      <col className="w-[170px]" />
                      <col className="w-[130px]" />
                      <col className="w-[90px]" />
                      <col className="w-[100px]" />
                      <col className="w-[100px]" />
                      <col className="w-[230px]" />
                    </colgroup>
                    <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                      <tr>
                        <Th>Family</Th>
                        <Th>Class</Th>
                        <Th>Status</Th>
                        <Th align="right">Files</Th>
                        <Th align="right">Logical</Th>
                        <Th align="right">Allocated</Th>
                        <Th>Maintenance</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {report.families.map((family) => (
                        <FamilyRow key={family.inventory.family_id} family={family} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>

            <details
              data-storage-disclosure="roots"
              className="group min-w-0 rounded-xl border border-border/60 bg-card shadow-sm"
            >
              <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 p-4 marker:hidden">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-cyan-500/10 text-cyan-600 dark:text-cyan-300">
                    <FolderTree className="size-5" aria-hidden />
                  </div>
                  <div className="min-w-0">
                    <h3 id="roots-heading" className="font-semibold">
                      <Term term="Registered roots" />
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      Cataloged filesystem locations with safe labels
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium tabular-nums">
                    {report.catalog.rootCount} records
                  </span>
                  <ChevronRight
                    className="size-5 text-muted-foreground group-open:hidden"
                    aria-hidden
                  />
                  <ChevronDown
                    className="hidden size-5 text-muted-foreground group-open:block"
                    aria-hidden
                  />
                </div>
              </summary>
              <div className="border-t border-border/60 p-3 sm:p-4">
                <p className="mb-3 text-xs text-muted-foreground">
                  Aggregate labels only. Physical path contents and stored records remain private.
                </p>
                <div className="min-w-0 grid gap-2 md:hidden">
                  {report.families.flatMap(({ inventory }) =>
                    inventory.roots.map((rootRow) => (
                      <RootMobileCard
                        key={`${inventory.family_id}:${rootRow.root_index}`}
                        familyId={inventory.family_id}
                        root={rootRow}
                      />
                    )),
                  )}
                </div>
                <div className="hidden overflow-x-auto rounded-xl border border-border/60 md:block">
                  <table className="storage-root-table min-w-[1300px] w-full table-fixed text-sm">
                    <colgroup>
                      <col className="w-[230px]" />
                      <col className="w-[320px]" />
                      <col className="w-[120px]" />
                      <col className="w-[130px]" />
                      <col className="w-[85px]" />
                      <col className="w-[95px]" />
                      <col className="w-[95px]" />
                      <col className="w-[225px]" />
                    </colgroup>
                    <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                      <tr>
                        <Th>Family</Th>
                        <Th>Root label</Th>
                        <Th>Ownership</Th>
                        <Th>State</Th>
                        <Th align="right">Files</Th>
                        <Th align="right">Logical</Th>
                        <Th align="right">Allocated</Th>
                        <Th>Reasons</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {report.families.flatMap(({ inventory }) =>
                        inventory.roots.map((rootRow) => (
                          <tr
                            key={`${inventory.family_id}:${rootRow.root_index}`}
                            className="align-top odd:bg-muted/20 hover:bg-muted/50"
                          >
                            <Td mono>
                              <StorageHelp
                                name={`table-root-family-${inventory.family_id}-${rootRow.root_index}`}
                                help={storageTermHelp("Family")}
                              >
                                <span>{inventory.family_id}</span>
                              </StorageHelp>
                            </Td>
                            <Td mono>
                              <StorageHelp
                                name={`table-root-label-${inventory.family_id}-${rootRow.root_index}`}
                                help={storageTermHelp("Root label")}
                                className="w-full min-w-0 overflow-hidden"
                              >
                                <span className="min-w-0 [overflow-wrap:anywhere]">
                                  {rootRow.root_label}
                                </span>
                              </StorageHelp>
                            </Td>
                            <Td>{rootRow.ownership}</Td>
                            <Td>
                              <StateBadge state={rootRow.state} />
                            </Td>
                            <Td align="right">{formatMeasurement(rootRow.totals.regular_files)}</Td>
                            <Td align="right">{formatMeasurement(rootRow.totals.logical_bytes)}</Td>
                            <Td align="right">
                              {formatMeasurement(rootRow.totals.allocated_bytes)}
                            </Td>
                            <Td>
                              <ReasonList reasons={rootRow.reason_codes} />
                            </Td>
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>
          </div>
        </section>

        <details
          data-storage-disclosure="measurement"
          className="group min-w-0 rounded-xl border border-border/60 bg-card text-sm shadow-sm"
        >
          <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 p-4 marker:hidden">
            <div className="flex items-center gap-3">
              <div className="grid size-10 place-items-center rounded-lg bg-zinc-500/10 text-zinc-600 dark:text-zinc-300">
                <ScanSearch className="size-5" aria-hidden />
              </div>
              <div>
                <h2 className="font-semibold">How this measurement works</h2>
                <p className="text-xs text-muted-foreground">
                  Scan scope, privacy contract, safety boundaries, and schemas
                </p>
              </div>
            </div>
            <ChevronRight className="size-5 text-muted-foreground group-open:hidden" aria-hidden />
            <ChevronDown
              className="hidden size-5 text-muted-foreground group-open:block"
              aria-hidden
            />
          </summary>
          <div className="grid gap-3 border-t border-border/60 p-4 lg:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
              <div className="mb-3 flex items-center gap-2 font-medium">
                <ScanSearch className="size-4" aria-hidden /> <Term term="Scan scope" />
              </div>
              <DefinitionList
                rows={[
                  [
                    "Coordination root",
                    formatTotals(report.inventory.scope_totals.coordination_root),
                  ],
                  [
                    "Registered external roots",
                    formatTotals(report.inventory.scope_totals.registered_external_roots),
                  ],
                  ["Traversal", report.inventory.scan.mode],
                  ["Concurrency", report.inventory.scan.max_concurrency.toLocaleString()],
                  ["Content read", report.inventory.privacy.content_read ? "yes" : "no"],
                  ["Path mode", report.inventory.privacy.path_mode],
                ]}
              />
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 p-4 text-xs leading-relaxed text-muted-foreground">
              <div className="mb-2 flex items-center gap-2 font-medium text-foreground">
                <Info className="size-4" aria-hidden /> <Term term="Safety boundary" />
              </div>
              This page is read-only. Maintenance stays dry-run-first and requires an exact
              persisted transaction, explicit confirmation, and provider-specific authorization in
              the CLI.
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 p-4 text-xs leading-relaxed text-muted-foreground">
              <div className="mb-2 flex items-center gap-2 font-medium text-foreground">
                <Archive className="size-4" aria-hidden /> <Term term="Schemas" />
              </div>
              <code>{report.inventory.schema}</code>
              <br />
              <StorageHelp
                name="health-schema"
                help="The versioned machine contract for the derived storage-health report."
              >
                <code>{report.health.schema}</code>
              </StorageHelp>
            </div>
          </div>
        </details>
      </main>
    </div>
  );
}

type ClassVisualRow = { row: StorageClassSummary; bytes: number };
type FamilyVisualRow = { family: StorageFamilyView; bytes: number };

function SignalCard({
  icon,
  label,
  value,
  detail,
  help,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail: React.ReactNode;
  help: string;
  tone: "success" | "warning" | "sky" | "muted";
}) {
  const toneClass = {
    success: "border-emerald-500/25 bg-emerald-500/5 text-emerald-600 dark:text-emerald-300",
    warning: "border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-300",
    sky: "border-sky-500/25 bg-sky-500/5 text-sky-600 dark:text-sky-300",
    muted: "border-border/60 bg-muted/20 text-muted-foreground",
  }[tone];
  return (
    <Card className={`storage-signal-card min-w-0 ${toneClass}`}>
      <CardContent className="gap-1">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="grid size-9 place-items-center rounded-lg bg-background/70 [&_svg]:size-4">
            {icon}
          </div>
          <Sparkles className="size-3.5 opacity-40" aria-hidden />
        </div>
        <div className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">
          <StorageHelp name={`signal-value-${label}`} help={help} className="text-2xl">
            <span>{value}</span>
          </StorageHelp>
        </div>
        <div className="text-xs font-medium text-foreground">
          <StorageHelp name={`signal-${label}`} help={help}>
            <span>{label}</span>
          </StorageHelp>
        </div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </CardContent>
    </Card>
  );
}

function ClassDonut({ rows, totalBytes }: { rows: readonly ClassVisualRow[]; totalBytes: number }) {
  const dominant = rows[0];
  const dominantPercent = dominant && totalBytes > 0 ? (dominant.bytes / totalBytes) * 100 : 0;
  return (
    <div
      className="relative mx-auto grid size-40 shrink-0 place-items-center rounded-full sm:size-44"
      style={{ background: classConicGradient(rows, totalBytes) }}
      role="img"
      aria-label={`Storage composition. ${rows
        .map(({ row, bytes }) => `${classLabel(row.storageClass)} ${formatStorageBytes(bytes)}`)
        .join(", ")}.`}
    >
      <div className="grid size-[68%] place-items-center rounded-full border border-border/60 bg-card text-center shadow-inner">
        <div>
          <div className="text-2xl font-semibold tabular-nums">
            {formatPercent(dominantPercent)}
          </div>
          <div className="mt-0.5 max-w-20 text-[10px] leading-tight text-muted-foreground">
            {dominant ? classLabel(dominant.row.storageClass) : "No data"}
          </div>
        </div>
      </div>
    </div>
  );
}

function StorageComposition({
  rows,
  totalBytes,
}: {
  rows: readonly ClassVisualRow[];
  totalBytes: number;
}) {
  return (
    <Card data-storage-chart="composition" className="storage-composition-card min-w-0">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-lg bg-cyan-500/10 text-cyan-600 dark:text-cyan-300">
            <PieChart className="size-4" aria-hidden />
          </div>
          <div>
            <CardTitle>
              <Term term="Footprint by storage class" />
            </CardTitle>
            <CardDescription>What kind of data is using the space</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="gap-4">
        <div className="flex h-3 overflow-hidden rounded-full bg-muted" aria-hidden>
          {rows.map(({ row, bytes }) => (
            <div
              key={row.storageClass}
              className={CLASS_BAR[row.storageClass] ?? "bg-zinc-500"}
              style={{ width: `${totalBytes > 0 ? (bytes / totalBytes) * 100 : 0}%` }}
            />
          ))}
        </div>
        <div className="grid gap-3">
          {rows.map(({ row }) => (
            <ClassBar key={row.storageClass} row={row} totalBytes={totalBytes} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function TopFamiliesChart({
  rows,
  totalBytes,
}: {
  rows: readonly FamilyVisualRow[];
  totalBytes: number;
}) {
  const maxBytes = rows[0]?.bytes ?? 0;
  return (
    <Card data-storage-chart="top-families" className="storage-top-families min-w-0">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-300">
            <Layers3 className="size-4" aria-hidden />
          </div>
          <div>
            <CardTitle>Largest storage areas</CardTitle>
            <CardDescription>Largest contributors to logical storage</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="gap-3">
        {rows.map(({ family, bytes }, index) => {
          const share = totalBytes > 0 ? (bytes / totalBytes) * 100 : 0;
          const relative = maxBytes > 0 ? (bytes / maxBytes) * 100 : 0;
          return (
            <div key={family.inventory.family_id} className="storage-family-bar min-w-0">
              <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="w-4 shrink-0 font-mono text-[10px] text-muted-foreground">
                    {index + 1}
                  </span>
                  <StorageHelp
                    name={`top-family-${family.inventory.family_id}`}
                    help={`${family.inventory.family_id} uses ${formatStorageBytes(bytes)}, or ${formatPercent(share)} of the current logical footprint. ${storageClassHelp(family.inventory.storage_class)}`}
                    className="min-w-0"
                  >
                    <span className="truncate font-medium">{family.inventory.family_id}</span>
                  </StorageHelp>
                </div>
                <span className="shrink-0 font-medium tabular-nums">
                  {formatStorageBytes(bytes)}
                </span>
              </div>
              <div className="ml-6 flex items-center gap-2">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${CLASS_BAR[family.inventory.storage_class] ?? "bg-zinc-500"}`}
                    style={{ width: `${Math.max(relative, 1)}%` }}
                  />
                </div>
                <span className="w-12 text-right text-[10px] tabular-nums text-muted-foreground">
                  {formatPercent(share)}
                </span>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function LogBudgetOverview({ families }: { families: readonly StorageFamilyView[] }) {
  const rows = families
    .map((family) => ({
      family,
      ratio: family.inventory.log_storage?.pressure.ratio ?? 0,
      managedBytes: family.inventory.log_storage?.usage.managed_bytes ?? 0,
      state: family.inventory.log_storage?.pressure.state ?? "unknown",
    }))
    .sort((a, b) => b.ratio - a.ratio || b.managedBytes - a.managedBytes);
  const overBudget = rows.filter(({ state }) => state === "over_budget").length;
  const active = rows.filter(({ managedBytes }) => managedBytes > 0).length;
  const peak = rows[0];

  return (
    <section aria-labelledby="logs-heading" className="mb-6">
      <div className="mb-3 flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
          <Gauge className="size-5" aria-hidden />
        </div>
        <div>
          <h2 id="logs-heading" className="text-lg font-semibold">
            <Term term="Log storage budgets" />
          </h2>
          <p className="text-sm text-muted-foreground">
            Capacity pressure first; policy details stay one click away.
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
        <Card className="border-emerald-500/20 bg-emerald-500/5">
          <CardContent className="justify-center gap-4">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <div className="text-2xl font-semibold tabular-nums">{families.length}</div>
                <div className="text-[11px] text-muted-foreground">budgets</div>
              </div>
              <div>
                <div className="text-2xl font-semibold tabular-nums">{active}</div>
                <div className="text-[11px] text-muted-foreground">using space</div>
              </div>
              <div>
                <div
                  className={`text-2xl font-semibold tabular-nums ${overBudget > 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-300"}`}
                >
                  {overBudget}
                </div>
                <div className="text-[11px] text-muted-foreground">over budget</div>
              </div>
            </div>
            <div className="rounded-lg border border-emerald-500/20 bg-background/70 p-3">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-muted-foreground">Highest pressure</span>
                <span className="font-semibold tabular-nums">
                  {peak ? formatPercent(peak.ratio * 100) : "0%"}
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className={overBudget > 0 ? "h-full bg-destructive" : "h-full bg-emerald-500"}
                  style={{ width: `${Math.min(100, Math.max((peak?.ratio ?? 0) * 100, 1))}%` }}
                />
              </div>
              <div className="mt-2 [overflow-wrap:anywhere] font-mono text-[11px] text-foreground/75">
                {peak?.family.inventory.family_id ?? "No active log family"}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card data-storage-chart="budget-pressure" className="storage-budget-pressure">
          <CardHeader>
            <CardTitle>Highest utilization</CardTitle>
            <CardDescription>Usage compared with each family&apos;s own limit</CardDescription>
          </CardHeader>
          <CardContent className="gap-3">
            {rows.slice(0, 5).map(({ family, ratio, managedBytes, state }) => (
              <div key={family.inventory.family_id}>
                <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                  <span className="min-w-0 [overflow-wrap:anywhere] font-mono">
                    {family.inventory.family_id}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatStorageBytes(managedBytes)} · {formatPercent(ratio * 100)}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${state === "over_budget" ? "bg-destructive" : "bg-emerald-500"}`}
                    style={{
                      width: `${Math.min(100, Math.max(ratio * 100, managedBytes > 0 ? 1 : 0))}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <details
        data-storage-disclosure="log-policies"
        className="group mt-3 min-w-0 rounded-xl border border-border/60 bg-card shadow-sm"
      >
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 p-4 marker:hidden">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" aria-hidden />
            <span className="font-medium">View every log policy</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums">
              {families.length}
            </span>
          </div>
          <ChevronRight className="size-5 text-muted-foreground group-open:hidden" aria-hidden />
          <ChevronDown
            className="hidden size-5 text-muted-foreground group-open:block"
            aria-hidden
          />
        </summary>
        <div className="grid gap-3 border-t border-border/60 p-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map(({ family }) => (
            <LogBudgetCard key={family.inventory.family_id} family={family} />
          ))}
        </div>
      </details>
    </section>
  );
}

function ClassBar({ row, totalBytes }: { row: StorageClassSummary; totalBytes: number }) {
  const bytes = observed(row.totals.logical_bytes) ?? 0;
  const ratio = totalBytes > 0 ? Math.min(1, bytes / totalBytes) : 0;
  return (
    <div className="storage-class-row">
      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`size-2.5 shrink-0 rounded-full ${CLASS_BAR[row.storageClass] ?? "bg-zinc-500"}`}
            aria-hidden
          />
          <StorageHelp
            name={`storage-class-${row.storageClass}`}
            help={storageClassHelp(row.storageClass)}
            className="min-w-0"
          >
            <span className="truncate font-medium text-foreground">
              {classLabel(row.storageClass)}
            </span>
          </StorageHelp>
        </div>
        <StorageHelp
          name={`storage-class-totals-${row.storageClass}`}
          help={`${storageByteHelp(bytes)} This class contains ${row.families} families; ${row.degraded} are degraded and ${row.unknown} are unknown.`}
        >
          <span className="shrink-0 font-medium tabular-nums text-foreground">
            {formatStorageBytes(bytes)}
          </span>
        </StorageHelp>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className={`h-full rounded-full ${CLASS_BAR[row.storageClass] ?? "bg-zinc-500"}`}
          style={{ width: `${Math.max(ratio * 100, bytes > 0 ? 1 : 0)}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
        <span>
          {row.families} families · {row.degraded + row.unknown} need review
        </span>
        <span className="font-medium tabular-nums">{formatPercent(ratio * 100)}</span>
      </div>
    </div>
  );
}

function LogBudgetCard({ family }: { family: StorageFamilyView }) {
  const log = family.inventory.log_storage!;
  const policy = log.effective_policy;
  const ratio = log.pressure.ratio == null ? 0 : Math.min(1, log.pressure.ratio);
  return (
    <Card className="storage-log-card min-w-0">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="font-mono break-all">
              <StorageHelp
                name={`log-family-${family.inventory.family_id}`}
                help="This is the stable identifier for one log storage family. Its limit applies only to this family."
              >
                <span>{family.inventory.family_id}</span>
              </StorageHelp>
            </CardTitle>
            <CardDescription>
              <StorageHelp
                name={`log-class-${family.inventory.family_id}`}
                help={storageClassHelp(family.inventory.storage_class)}
              >
                <span>{classLabel(family.inventory.storage_class)}</span>
              </StorageHelp>
            </CardDescription>
          </div>
          <StateBadge state={log.pressure.state} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="text-xl font-semibold tabular-nums">
              <StorageHelp
                name={`managed-usage-${family.inventory.family_id}`}
                help={storageByteHelp(log.usage.managed_bytes)}
                className="text-xl"
              >
                <span>{formatStorageBytes(log.usage.managed_bytes)}</span>
              </StorageHelp>
            </div>
            <div className="text-xs text-muted-foreground">
              <Term term="Managed usage" />
            </div>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>
              <StorageHelp
                name={`maximum-${family.inventory.family_id}`}
                help={
                  policy
                    ? `${storageTermHelp("Maximum")} ${storageByteHelp(policy.max_bytes)}`
                    : "The effective maximum could not be resolved."
                }
              >
                <span>
                  {policy ? `${formatStorageBytes(policy.max_bytes)} max` : "limit unavailable"}
                </span>
              </StorageHelp>
            </div>
            <div>
              <StorageHelp name={`age-${family.inventory.family_id}`} help={storageTermHelp("Age")}>
                <span>{policy ? `${policy.max_age_days} days` : "age unavailable"}</span>
              </StorageHelp>
            </div>
          </div>
        </div>
        <span className="sr-only">Managed byte pressure: {Math.round(ratio * 100)}%</span>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div
            className={`h-full rounded-full ${log.pressure.state === "over_budget" ? "bg-destructive" : "bg-emerald-500"}`}
            style={{ width: `${Math.max(ratio * 100, log.usage.managed_bytes > 0 ? 1 : 0)}%` }}
          />
        </div>
        <DefinitionList
          rows={[
            ["Unmanaged", formatStorageBytes(log.usage.unmanaged_bytes)],
            ["Retention", `${log.retention.state} · ${log.retention.enforcement}`],
            ["Bytes source", policy?.provenance.max_bytes.source ?? "unavailable"],
            ["Age source", policy?.provenance.max_age_days.source ?? "unavailable"],
          ]}
        />
        <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-xs">
          <span className="text-muted-foreground">Reasons</span>
          <span className="text-right">
            <ReasonList reasons={[...log.pressure.reason_codes, ...log.retention.reason_codes]} />
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function FamilyRow({ family }: { family: StorageFamilyView }) {
  const { inventory, health, descriptor } = family;
  return (
    <tr className="align-top odd:bg-muted/20 hover:bg-muted/50">
      <Td>
        <details className="group max-w-md">
          <summary className="flex cursor-pointer list-none items-start font-mono font-medium marker:hidden">
            <ChevronRight
              className="mt-0.5 mr-2 size-4 shrink-0 text-muted-foreground group-open:hidden"
              aria-hidden
            />
            <ChevronDown
              className="mt-0.5 mr-2 hidden size-4 shrink-0 text-muted-foreground group-open:block"
              aria-hidden
            />
            <StorageHelp
              name={`family-${inventory.family_id}`}
              help="Stable identifier for this storage family. Expand the row to see its owner and policy contract."
            >
              <span className="break-words">{inventory.family_id}</span>
            </StorageHelp>
          </summary>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <dt>
              <Term term="Owner" />
            </dt>
            <dd>{descriptor.owner}</dd>
            <dt>
              <Term term="Provider" />
            </dt>
            <dd className="font-mono break-all">{inventory.provider_id}</dd>
            <dt>
              <Term term="Policy" />
            </dt>
            <dd className="font-mono break-all">{inventory.policy_version}</dd>
            <dt>
              <Term term="Format" />
            </dt>
            <dd>{descriptor.format}</dd>
            <dt>
              <Term term="Durability" />
            </dt>
            <dd>{descriptor.durability}</dd>
            <dt>
              <Term term="Sensitivity" />
            </dt>
            <dd>{descriptor.sensitivity}</dd>
            <dt>
              <Term term="Writer" />
            </dt>
            <dd>{descriptor.writerModel}</dd>
            <dt>
              <Term term="Consumers" />
            </dt>
            <dd>{descriptor.consumers.join(", ")}</dd>
            <dt>
              <Term term="Roots" />
            </dt>
            <dd>{inventory.roots.length}</dd>
            <dt>
              <Term term="Reasons" />
            </dt>
            <dd>
              <ReasonList reasons={inventory.reason_codes} />
            </dd>
          </dl>
        </details>
      </Td>
      <Td>
        <Badge
          variant="outline"
          title={storageClassHelp(inventory.storage_class)}
          tabIndex={0}
          data-storage-help={`family-class-${inventory.family_id}`}
        >
          {classLabel(inventory.storage_class)}
        </Badge>
        <div className="mt-1 text-xs text-muted-foreground">{inventory.source}</div>
      </Td>
      <Td>
        <HealthBadge status={health.status} />
        <div className="mt-1">
          <StateBadge state={inventory.state} />
        </div>
      </Td>
      <Td align="right">{formatMeasurement(inventory.totals.regular_files)}</Td>
      <Td align="right">{formatMeasurement(inventory.totals.logical_bytes)}</Td>
      <Td align="right">{formatMeasurement(inventory.totals.allocated_bytes)}</Td>
      <Td>
        <StateBadge state={inventory.maintenance.state} />
        {inventory.maintenance.reason_code ? (
          <div className="mt-1 text-xs text-muted-foreground">
            <ReasonList reasons={[inventory.maintenance.reason_code]} />
          </div>
        ) : null}
      </Td>
    </tr>
  );
}

function FamilyMobileCard({ family }: { family: StorageFamilyView }) {
  const { inventory, health, descriptor } = family;
  return (
    <details className="group rounded-lg border border-border/60 bg-card p-3">
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 marker:hidden">
        <div className="flex min-w-0 items-start gap-2">
          <ChevronRight
            className="mt-0.5 size-4 shrink-0 text-muted-foreground group-open:hidden"
            aria-hidden
          />
          <ChevronDown
            className="mt-0.5 hidden size-4 shrink-0 text-muted-foreground group-open:block"
            aria-hidden
          />
          <div className="min-w-0">
            <div className="font-mono text-sm font-medium break-words">
              <StorageHelp
                name={`mobile-family-${inventory.family_id}`}
                help="Stable identifier for this storage family. Expand the card to see its full ownership contract."
              >
                <span>{inventory.family_id}</span>
              </StorageHelp>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              <StorageHelp
                name={`mobile-family-class-${inventory.family_id}`}
                help={storageClassHelp(inventory.storage_class)}
              >
                <span>{classLabel(inventory.storage_class)}</span>
              </StorageHelp>{" "}
              · {inventory.source}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <HealthBadge status={health.status} />
          <StateBadge state={inventory.state} />
        </div>
      </summary>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border/60 pt-3 text-xs">
        <MobileMeasurement
          label="Files"
          value={formatMeasurement(inventory.totals.regular_files)}
        />
        <MobileMeasurement
          label="Logical"
          value={formatMeasurement(inventory.totals.logical_bytes)}
        />
        <MobileMeasurement
          label="Allocated"
          value={formatMeasurement(inventory.totals.allocated_bytes)}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">
          <Term term="Maintenance" />
        </span>
        <StateBadge state={inventory.maintenance.state} />
        {inventory.maintenance.reason_code ? (
          <ReasonList reasons={[inventory.maintenance.reason_code]} />
        ) : null}
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 border-t border-border/60 pt-3 text-xs">
        <dt className="text-muted-foreground">
          <Term term="Owner" />
        </dt>
        <dd className="text-right break-words">{descriptor.owner}</dd>
        <dt className="text-muted-foreground">
          <Term term="Provider" />
        </dt>
        <dd className="text-right font-mono break-words">{inventory.provider_id}</dd>
        <dt className="text-muted-foreground">
          <Term term="Policy" />
        </dt>
        <dd className="text-right font-mono break-words">{inventory.policy_version}</dd>
        <dt className="text-muted-foreground">
          <Term term="Format" />
        </dt>
        <dd className="text-right break-words">{descriptor.format}</dd>
        <dt className="text-muted-foreground">
          <Term term="Durability" />
        </dt>
        <dd className="text-right break-words">{descriptor.durability}</dd>
        <dt className="text-muted-foreground">
          <Term term="Sensitivity" />
        </dt>
        <dd className="text-right break-words">{descriptor.sensitivity}</dd>
        <dt className="text-muted-foreground">
          <Term term="Writer" />
        </dt>
        <dd className="text-right break-words">{descriptor.writerModel}</dd>
        <dt className="text-muted-foreground">
          <Term term="Consumers" />
        </dt>
        <dd className="text-right break-words">{descriptor.consumers.join(", ")}</dd>
        <dt className="text-muted-foreground">
          <Term term="Roots" />
        </dt>
        <dd className="text-right">{inventory.roots.length}</dd>
        <dt className="text-muted-foreground">
          <Term term="Reasons" />
        </dt>
        <dd className="text-right">
          <ReasonList reasons={inventory.reason_codes} />
        </dd>
      </dl>
    </details>
  );
}

function RootMobileCard({
  familyId,
  root,
}: {
  familyId: string;
  root: StorageFamilyView["inventory"]["roots"][number];
}) {
  return (
    <article className="min-w-0 max-w-full rounded-lg border border-border/60 bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-xs text-muted-foreground break-words">
            <StorageHelp
              name={`root-family-${familyId}-${root.root_index}`}
              help={storageTermHelp("Family")}
            >
              <span>{familyId}</span>
            </StorageHelp>
          </div>
          <div className="mt-1 font-mono text-sm font-medium break-words">
            <StorageHelp
              name={`root-label-${familyId}-${root.root_index}`}
              help={storageTermHelp("Root label")}
            >
              <span>{root.root_label}</span>
            </StorageHelp>
          </div>
        </div>
        <StateBadge state={root.state} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border/60 pt-3 text-xs">
        <MobileMeasurement label="Files" value={formatMeasurement(root.totals.regular_files)} />
        <MobileMeasurement label="Logical" value={formatMeasurement(root.totals.logical_bytes)} />
        <MobileMeasurement
          label="Allocated"
          value={formatMeasurement(root.totals.allocated_bytes)}
        />
      </div>
      <dl className="mt-3 min-w-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">
          <Term term="Ownership" />
        </dt>
        <dd className="min-w-0 text-right break-words">{root.ownership}</dd>
        <dt className="text-muted-foreground">
          <Term term="Reasons" />
        </dt>
        <dd className="text-right">
          <ReasonList reasons={root.reason_codes} />
        </dd>
      </dl>
    </article>
  );
}

function MobileMeasurement({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground">
        <Term term={label} />
      </div>
      <div className="mt-0.5 font-mono break-words">{value}</div>
    </div>
  );
}

function IssuePanel({ report }: { report: Awaited<ReturnType<typeof readStorageFootprint>> }) {
  const items = [
    ...report.inventory.issues.map((issue) => ({
      key: `issue-${issue.reason_code}`,
      label: formatReasonLabel(issue.reason_code),
      count: issue.count,
      help: `${storageReasonHelp(issue.reason_code)} This reason appeared ${issue.count.toLocaleString()} times in the current capture.`,
    })),
    ...report.catalog.diagnostics.map((diagnostic) => ({
      key: `diagnostic-${diagnostic.code}`,
      label: `${formatReasonLabel(diagnostic.code)}: ${diagnostic.message}`,
      count: 1,
      help: `Catalog diagnostic “${diagnostic.code}”. ${diagnostic.message}`,
    })),
    ...report.catalog.dormantLogStorageFamilies.map((family) => ({
      key: `dormant-${family}`,
      label: `dormant override: ${family}`,
      count: 1,
      help: `${storageReasonHelp("root_dormant")} The override names “${family}”.`,
    })),
  ];
  if (items.length === 0) return null;
  const maxCount = Math.max(...items.map(({ count }) => count), 1);
  const totalCount = items.reduce((sum, { count }) => sum + count, 0);
  return (
    <section
      aria-labelledby="issues-heading"
      className="storage-attention mb-6 rounded-xl border border-amber-500/40 bg-amber-500/8 p-4 sm:p-5"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-300">
            <TriangleAlert className="size-5" aria-hidden />
          </div>
          <div>
            <h2 id="issues-heading" className="font-semibold">
              <StorageHelp
                name="inventory-attention"
                help="Inventory completed, but these conditions need explanation or cleanup. They do not mean the scan failed or that data was deleted."
              >
                <span>What needs attention</span>
              </StorageHelp>
            </h2>
            <p className="text-xs text-muted-foreground">
              Exceptions from this scan, grouped by reason
            </p>
          </div>
        </div>
        <div className="rounded-full border border-amber-500/30 bg-background/60 px-3 py-1 text-xs font-medium tabular-nums text-amber-700 dark:text-amber-200">
          {totalCount.toLocaleString()} observations
        </div>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {items.map((item) => (
          <li key={item.key} className="rounded-lg border border-amber-500/20 bg-background/65 p-3">
            <div className="flex items-start justify-between gap-3">
              <StorageHelp name={item.key} help={item.help} className="min-w-0">
                <span className="text-sm font-medium capitalize">{item.label}</span>
              </StorageHelp>
              <span className="shrink-0 text-xl font-semibold tabular-nums text-amber-700 dark:text-amber-200">
                {item.count.toLocaleString()}
              </span>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-amber-500/10" aria-hidden>
              <div
                className="h-full rounded-full bg-amber-500"
                style={{ width: `${Math.max((item.count / maxCount) * 100, 2)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DefinitionList({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">
            <Term term={label} />
          </dt>
          <dd className="text-right font-mono break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReasonList({ reasons }: { reasons: readonly string[] }) {
  const unique = [...new Set(reasons)];
  return unique.length ? (
    <span className="text-xs text-muted-foreground break-words">
      {unique.map((reason, index) => (
        <span key={reason}>
          {index > 0 ? ", " : ""}
          <StorageHelp name={`reason-${reason}`} help={storageReasonHelp(reason)}>
            <span>{formatReasonLabel(reason)}</span>
          </StorageHelp>
        </span>
      ))}
    </span>
  ) : (
    <span className="text-xs text-muted-foreground">none</span>
  );
}

function HealthBadge({ status }: { status: string }) {
  const variant = status === "healthy" ? "success" : status === "degraded" ? "warning" : "muted";
  return (
    <Badge
      variant={variant}
      title={storageStateHelp(status)}
      tabIndex={0}
      data-storage-help={`health-${status}`}
    >
      {status}
    </Badge>
  );
}

function StateBadge({ state }: { state: string }) {
  const variant = ["present", "eligible", "within_budget", "active", "healthy"].includes(state)
    ? "success"
    : ["degraded", "over_budget", "blocked", "unavailable"].includes(state)
      ? "warning"
      : "muted";
  return (
    <Badge
      variant={variant}
      title={storageStateHelp(state)}
      tabIndex={0}
      data-storage-help={`state-${state}`}
    >
      {formatReasonLabel(state)}
    </Badge>
  );
}

function Term({ term, children }: { term: string; children?: React.ReactNode }) {
  const name = term
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/(^-|-$)/g, "");
  return (
    <StorageHelp name={`term-${name}`} help={storageTermHelp(term)}>
      <span>{children ?? term}</span>
    </StorageHelp>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 font-medium ${align === "right" ? "text-right" : "text-left"}`}
    >
      {typeof children === "string" ? <Term term={children} /> : children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  mono = false,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  mono?: boolean;
}) {
  return (
    <td
      className={`break-words px-3 py-2.5 ${align === "right" ? "text-right tabular-nums" : "text-left"} ${mono ? "font-mono text-xs" : ""}`}
    >
      {children}
    </td>
  );
}

function classLabel(storageClass: string): string {
  return CLASS_LABELS[storageClass] ?? storageClass;
}

function formatTotals(totals: {
  regular_files: Measurement;
  logical_bytes: Measurement;
  allocated_bytes: Measurement;
}): string {
  return `${formatMeasurement(totals.logical_bytes)} · ${formatMeasurement(totals.regular_files)} files`;
}

type Measurement =
  | { state: "observed"; unit: "files" | "bytes"; value: number }
  | { state: "unavailable"; unit: "files" | "bytes"; reason_code: string };

function observed(measurement: Measurement): number | null {
  return measurement.state === "observed" ? measurement.value : null;
}

function formatMeasurement(measurement: Measurement): string {
  if (measurement.state === "unavailable") {
    return "unavailable";
  }
  return measurement.unit === "bytes"
    ? formatStorageBytes(measurement.value)
    : formatCount(measurement.value);
}

function formatCount(value: number | null): string {
  return value == null ? "unavailable" : value.toLocaleString();
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${value.toLocaleString("en-US", {
    minimumFractionDigits: value > 0 && value < 1 ? 1 : 0,
    maximumFractionDigits: value >= 10 ? 0 : 1,
  })}%`;
}

function classConicGradient(rows: readonly ClassVisualRow[], totalBytes: number): string {
  if (totalBytes <= 0 || rows.length === 0) return "conic-gradient(#71717a 0% 100%)";
  let cursor = 0;
  const segments = rows.map(({ row, bytes }) => {
    const start = cursor;
    cursor += (bytes / totalBytes) * 100;
    return `${CLASS_COLOR[row.storageClass] ?? "#71717a"} ${start}% ${cursor}%`;
  });
  if (cursor < 100) segments.push(`#27272a ${cursor}% 100%`);
  return `conic-gradient(${segments.join(", ")})`;
}
