import { notFound } from "next/navigation";

import { DiagnosticsDashboard } from "@/components/diagnostics/DiagnosticsDashboard";
import { NavBar } from "@/components/NavBar";
import { hostInfo } from "@/lib/config";
import { coordRoot } from "@/lib/coord-reader";
import {
  type DiagnosticsViewModel,
  normalizeDiagnosticsQuery,
  readFrozenDiagnostics,
} from "@/lib/diagnostics-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Diagnostic bundle · Harnery" };

interface PageProps {
  params: Promise<{ bundleId: string }>;
  searchParams: Promise<{
    finding?: string | string[];
    state?: string | string[];
    severity?: string | string[];
    source?: string | string[];
  }>;
}

export default async function DiagnosticBundlePage({ params, searchParams }: PageProps) {
  const [{ bundleId }, rawFilters] = await Promise.all([params, searchParams]);
  const filters = normalizeDiagnosticsQuery(rawFilters);
  const root = coordRoot();
  let model: DiagnosticsViewModel;
  try {
    model = readFrozenDiagnostics(root, bundleId, filters);
  } catch {
    notFound();
  }
  const basePath = `/diagnostics/bundles/${encodeURIComponent(bundleId)}`;
  return (
    <div className="min-h-screen bg-background text-foreground">
      <NavBar scannedDir={root} />
      <main className="mx-auto max-w-screen-2xl px-4 pb-12 sm:px-6">
        <DiagnosticsDashboard
          model={model}
          filters={filters}
          basePath={basePath}
          binName={hostInfo().binName}
        />
      </main>
    </div>
  );
}
