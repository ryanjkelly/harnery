import {
  Archive,
  ChevronDown,
  ChevronRight,
  Database,
  FileStack,
  HardDrive,
  Info,
  ShieldCheck,
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

export default async function StoragePage() {
  const root = coordRoot();
  const report = await readStorageFootprint(root);
  const filesystemBytes = observed(report.inventory.filesystem_totals.logical_bytes);
  const allocatedBytes = observed(report.inventory.filesystem_totals.allocated_bytes);
  const files = observed(report.inventory.filesystem_totals.regular_files);
  const logFamilies = report.families.filter(({ inventory }) => inventory.log_storage);

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
          aria-label="Footprint summary"
          className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        >
          <MetricCard
            icon={<HardDrive aria-hidden />}
            label="Logical footprint"
            value={formatStorageBytes(filesystemBytes)}
            help={storageTermHelp("Logical footprint")}
            valueHelp={`${storageByteHelp(filesystemBytes)} This is current measured usage across all registered storage, not Harnery's maximum storage limit.`}
            detail={
              allocatedBytes == null
                ? "Physical disk usage unavailable"
                : `${formatStorageBytes(allocatedBytes)} physically allocated`
            }
          />
          <MetricCard
            icon={<FileStack aria-hidden />}
            label="Regular files"
            value={formatCount(files)}
            help={storageTermHelp("Regular files")}
            valueHelp={`${formatCount(files)} ordinary files were counted in this capture.`}
            detail={`${report.catalog.rootCount.toLocaleString()} registered roots`}
          />
          <MetricCard
            icon={<Database aria-hidden />}
            label="Storage catalog"
            value={report.catalog.familyCount.toLocaleString()}
            help={storageTermHelp("Storage catalog")}
            valueHelp={`${report.catalog.familyCount.toLocaleString()} storage families are registered in the canonical catalog.`}
            detail={`${report.catalog.storageClassCount} classes · ${logFamilies.length} log families`}
          />
          <MetricCard
            icon={<ShieldCheck aria-hidden />}
            label="Inventory contract"
            value="Metadata only"
            help={storageTermHelp("Inventory contract")}
            valueHelp={storageTermHelp("Metadata only")}
            detail="Aggregate labels · symlinks rejected"
          />
        </section>

        <IssuePanel report={report} />

        <section
          aria-labelledby="scope-heading"
          className="mb-6 grid gap-4 lg:grid-cols-[1.4fr_1fr]"
        >
          <Card>
            <CardHeader>
              <CardTitle id="scope-heading">
                <Term term="Footprint by storage class" />
              </CardTitle>
              <CardDescription>
                Registered families grouped by lifecycle and safety role.
              </CardDescription>
            </CardHeader>
            <CardContent className="gap-3">
              {report.classes.map((row) => (
                <ClassBar key={row.storageClass} row={row} totalBytes={filesystemBytes ?? 0} />
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <Term term="Scan scope" />
              </CardTitle>
              <CardDescription>
                Where the inventory looked and how it handled content.
              </CardDescription>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>
        </section>

        {logFamilies.length > 0 ? (
          <section aria-labelledby="logs-heading" className="mb-6">
            <div className="mb-3">
              <h2 id="logs-heading" className="text-lg font-semibold">
                <Term term="Log storage budgets" />
              </h2>
              <p className="text-sm text-muted-foreground">
                Effective limits, source provenance, managed usage, and manual retention state.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {logFamilies.map((family) => (
                <LogBudgetCard key={family.inventory.family_id} family={family} />
              ))}
            </div>
          </section>
        ) : null}

        <section aria-labelledby="families-heading" className="mb-6">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="families-heading" className="text-lg font-semibold">
                <Term term="Registered families" />
              </h2>
              <p className="text-sm text-muted-foreground">
                Every catalog family remains in the page for browser Find. Expand a family for its
                ownership contract.
              </p>
            </div>
            <span className="text-xs text-muted-foreground">{report.families.length} families</span>
          </div>
          <div className="min-w-0 grid gap-2 md:hidden">
            {report.families.map((family) => (
              <FamilyMobileCard key={family.inventory.family_id} family={family} />
            ))}
          </div>
          <div className="hidden overflow-x-auto rounded-xl border border-border/60 bg-card md:block">
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
        </section>

        <section aria-labelledby="roots-heading" className="mb-6">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="roots-heading" className="text-lg font-semibold">
                <Term term="Registered roots" />
              </h2>
              <p className="text-sm text-muted-foreground">
                Aggregate labels only. Physical path contents and stored records remain private.
              </p>
            </div>
            <span className="text-xs text-muted-foreground">{report.catalog.rootCount} roots</span>
          </div>
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
          <div className="hidden overflow-x-auto rounded-xl border border-border/60 bg-card md:block">
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
                      <Td align="right">{formatMeasurement(rootRow.totals.allocated_bytes)}</Td>
                      <Td>
                        <ReasonList reasons={rootRow.reason_codes} />
                      </Td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </section>

        <footer className="grid gap-3 text-xs text-muted-foreground md:grid-cols-2">
          <div className="rounded-lg border border-border/60 bg-card p-4">
            <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
              <Info className="size-4" aria-hidden /> <Term term="Safety boundary" />
            </div>
            This page is read-only. Maintenance stays dry-run-first and requires an exact persisted
            transaction, explicit confirmation, and provider-specific authorization in the CLI.
          </div>
          <div className="rounded-lg border border-border/60 bg-card p-4">
            <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
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
        </footer>
      </main>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  detail,
  help,
  valueHelp,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail: React.ReactNode;
  help: string;
  valueHelp: string;
}) {
  return (
    <Card className="min-w-0">
      <CardContent className="gap-1">
        <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground [&_svg]:size-4">
          {icon}
          <StorageHelp name={`metric-${label}`} help={help}>
            <span>{label}</span>
          </StorageHelp>
        </div>
        <div className="text-2xl font-semibold tracking-tight tabular-nums">
          <StorageHelp name={`metric-value-${label}`} help={valueHelp} className="text-2xl">
            <span>{value}</span>
          </StorageHelp>
        </div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </CardContent>
    </Card>
  );
}

function ClassBar({ row, totalBytes }: { row: StorageClassSummary; totalBytes: number }) {
  const bytes = observed(row.totals.logical_bytes) ?? 0;
  const ratio = totalBytes > 0 ? Math.min(1, bytes / totalBytes) : 0;
  return (
    <div className="storage-class-row">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <StorageHelp
          name={`storage-class-${row.storageClass}`}
          help={storageClassHelp(row.storageClass)}
        >
          <span className="font-medium text-foreground">{classLabel(row.storageClass)}</span>
        </StorageHelp>
        <StorageHelp
          name={`storage-class-totals-${row.storageClass}`}
          help={`${storageByteHelp(bytes)} This class contains ${row.families} families; ${row.degraded} are degraded and ${row.unknown} are unknown.`}
        >
          <span className="tabular-nums text-muted-foreground">
            {formatStorageBytes(bytes)} · {row.families} families · {row.degraded} degraded ·{" "}
            {row.unknown} unknown
          </span>
        </StorageHelp>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className={`h-full rounded-full ${CLASS_BAR[row.storageClass] ?? "bg-zinc-500"}`}
          style={{ width: `${Math.max(ratio * 100, bytes > 0 ? 1 : 0)}%` }}
        />
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
      label: `${formatReasonLabel(issue.reason_code)} × ${issue.count}`,
      help: `${storageReasonHelp(issue.reason_code)} This reason appeared ${issue.count.toLocaleString()} times in the current capture.`,
    })),
    ...report.catalog.diagnostics.map((diagnostic) => ({
      key: `diagnostic-${diagnostic.code}`,
      label: `${formatReasonLabel(diagnostic.code)}: ${diagnostic.message}`,
      help: `Catalog diagnostic “${diagnostic.code}”. ${diagnostic.message}`,
    })),
    ...report.catalog.dormantLogStorageFamilies.map((family) => ({
      key: `dormant-${family}`,
      label: `dormant override: ${family}`,
      help: `${storageReasonHelp("root_dormant")} The override names “${family}”.`,
    })),
  ];
  if (items.length === 0) return null;
  return (
    <section
      aria-labelledby="issues-heading"
      className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4"
    >
      <div className="flex gap-3">
        <TriangleAlert
          className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-300"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <h2 id="issues-heading" className="font-medium">
            <StorageHelp
              name="inventory-attention"
              help="Inventory completed, but these conditions need explanation or cleanup. They do not mean the scan failed or that data was deleted."
            >
              <span>Inventory attention</span>
            </StorageHelp>
          </h2>
          <ul className="mt-2 grid gap-y-1 gap-x-8 text-sm text-muted-foreground sm:grid-cols-2">
            {items.map((item) => (
              <li key={item.key}>
                <StorageHelp name={item.key} help={item.help}>
                  <span>{item.label}</span>
                </StorageHelp>
              </li>
            ))}
          </ul>
        </div>
      </div>
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
