import { BrowseClient } from "@/components/file-viewer/BrowseClient";
import { NavBar } from "@/components/NavBar";
import { ARTIFACTS_BROWSE_ROOT, latestAgentArtifactDirectory } from "@/lib/artifact-browser";
import { coordRoot } from "@/lib/coord-reader";
import { inventoryArtifacts } from "../../../src/core/artifacts/index";

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
  const rawAgent = Array.isArray(sp.agent) ? sp.agent[0] : sp.agent;
  const initialPath = raw && raw.length > 0 ? raw : null;
  let initialDirectory: string | null = null;
  if (!initialPath && rawAgent) {
    try {
      initialDirectory =
        latestAgentArtifactDirectory(inventoryArtifacts(coordRoot()), rawAgent) ??
        ARTIFACTS_BROWSE_ROOT;
    } catch {
      initialDirectory = ARTIFACTS_BROWSE_ROOT;
    }
  }
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background">
      <NavBar scannedDir={coordRoot()} />
      <BrowseClient initialPath={initialPath} initialDirectory={initialDirectory} />
    </div>
  );
}
