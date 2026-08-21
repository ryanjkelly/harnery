import { FileText } from "lucide-react";
import Link from "next/link";
import { NavBar } from "@/components/NavBar";
import { coordRoot } from "@/lib/coord-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Files · Harnery" };

/**
 * /files: the canonical deep-link target for the universal file viewer.
 * `/files?path=<rel>` opens the overlay directly: the globally-mounted
 * FileViewerProvider (root layout) reads `?path=` on mount and auto-opens,
 * so this page only renders the backdrop landing underneath.
 * A path is also openable from any other page (event log, etc.) via <FilePath>;
 * this page is just the shareable home + the "no path" explainer.
 *
 * HTML "open preview in new tab" uses `/files/view?path=…` instead — a
 * full-page viewer that keeps `/api/file` non-navigable (text/plain).
 */
export default function FilesPage() {
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background">
      <NavBar scannedDir={coordRoot()} />
      <main className="flex flex-1 flex-col items-center justify-center px-6 pb-6 text-center">
        <FileText className="mb-4 size-10 text-muted-foreground/40" />
        <h1 className="mb-2 text-xl font-semibold tracking-tight">File viewer</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          Open any repo file in-dashboard. Click a file path in the{" "}
          <Link href="/events" className="underline hover:text-foreground">
            event log
          </Link>
          , search with{" "}
          <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-xs">⌘K</code>, browse the{" "}
          <Link href="/browse" className="underline hover:text-foreground">
            file tree
          </Link>
          , or deep-link directly with{" "}
          <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-xs">/files?path=…</code>.
        </p>
      </main>
    </div>
  );
}
