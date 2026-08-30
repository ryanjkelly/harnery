import { HardDrive } from "lucide-react";
import { NavBar } from "@/components/NavBar";
import { coordRoot } from "@/lib/coord-reader";

export default function StorageLoading() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <NavBar scannedDir={coordRoot()} />
      <main className="mx-auto max-w-screen-2xl px-4 pb-12 sm:px-6">
        <div className="mb-6 flex items-start gap-3" role="status" aria-live="polite">
          <div className="rounded-lg border border-border bg-card p-2 text-muted-foreground">
            <HardDrive className="size-5 animate-pulse" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Storage footprint</h1>
            <p className="text-sm text-muted-foreground">
              Scanning registered roots. Large repositories can take a few moments.
            </p>
          </div>
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
      </main>
    </div>
  );
}
