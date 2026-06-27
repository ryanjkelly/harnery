import { BrowseClient } from "@/components/file-viewer/BrowseClient";
import { NavBar } from "@/components/NavBar";
import { coordRoot } from "@/lib/coord-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Browse · Harnery" };

/**
 * /browse: split-pane repo file explorer — directory tree (left) + inline file
 * viewer (right). A human entry point for the same viewer the event-log
 * `?path=` deep links open in the modal overlay. `?file=<rel>` deep-links a
 * selection here (distinct from the overlay's `?path=`, on purpose — see
 * BrowseClient).
 */
export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.file) ? sp.file[0] : sp.file;
  const initialPath = raw && raw.length > 0 ? raw : null;
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background">
      <NavBar scannedDir={coordRoot()} />
      <BrowseClient initialPath={initialPath} />
    </div>
  );
}
