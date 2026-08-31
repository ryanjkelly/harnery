import { DiagnosticsDashboard } from "@/components/diagnostics/DiagnosticsDashboard";
import { DiagnosticsLiveRefresher } from "@/components/diagnostics/DiagnosticsLiveRefresher";
import { NavBar } from "@/components/NavBar";
import { hostInfo } from "@/lib/config";
import { coordRoot } from "@/lib/coord-reader";
import { normalizeDiagnosticsQuery, readLiveDiagnostics } from "@/lib/diagnostics-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Diagnostics · Harnery" };

interface PageProps {
  searchParams: Promise<{
    finding?: string | string[];
    state?: string | string[];
    severity?: string | string[];
    source?: string | string[];
  }>;
}

export default async function DiagnosticsPage({ searchParams }: PageProps) {
  const filters = normalizeDiagnosticsQuery(await searchParams);
  const root = coordRoot();
  const model = readLiveDiagnostics(root, filters);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <DiagnosticsLiveRefresher />
      <NavBar scannedDir={root} />
      <main className="mx-auto max-w-screen-2xl px-4 pb-12 sm:px-6">
        <DiagnosticsDashboard
          model={model}
          filters={filters}
          basePath="/diagnostics"
          binName={hostInfo().binName}
        />
      </main>
    </div>
  );
}
