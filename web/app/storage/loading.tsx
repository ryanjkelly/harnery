import { HardDrive } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";

export default function StorageLoading() {
  return (
    <PageShell width="wide">
      <div className="mb-6 flex items-start gap-3" role="status" aria-live="polite">
        <div className="rounded-lg border border-border bg-card p-2 text-muted-foreground">
          <HardDrive className="size-5 animate-pulse" aria-hidden />
        </div>
        <PageHeader
          className="mb-0 min-w-0 flex-1"
          title="Storage footprint"
          description="Scanning registered roots. Large repositories can take a few moments."
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-hidden>
        {["logical", "files", "catalog", "privacy"].map((slot) => (
          <div
            key={slot}
            className="h-28 animate-pulse rounded-xl border border-border/60 bg-card"
          />
        ))}
      </div>
      <div
        className="mt-4 h-72 animate-pulse rounded-xl border border-border/60 bg-card"
        aria-hidden
      />
    </PageShell>
  );
}
