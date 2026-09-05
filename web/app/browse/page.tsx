import { BrowseClient, type BrowseScope } from "@/components/file-viewer/BrowseClient";
import { NavBar } from "@/components/NavBar";
import { agentArtifactDirectories } from "@/lib/artifact-browser";
import { workspaceEntry } from "@/lib/browse-catalog";
import { coordRoot } from "@/lib/coord-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Browse · Harnery" };

/**
 * Folder and workspace browser with an optional inline preview. `?file=`
 * selects a file without opening the global `?path=` overlay.
 *
 * Agent and directory links establish the initial browsing scope:
 * - `?agent=<instance-id>`: the agent's managed artifact workspaces become the
 *   roots (newest first). An agent with no workspace gets an empty scope.
 * - `?dir=<rel-path>`: any repo directory becomes the sole root (a workflow
 *   run, a book, a vendor dump). `?agent=` wins when both are present.
 */
export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.file) ? sp.file[0] : sp.file;
  const rawAgent = Array.isArray(sp.agent) ? sp.agent[0] : sp.agent;
  const rawDir = Array.isArray(sp.dir) ? sp.dir[0] : sp.dir;
  const initialPath = raw && raw.length > 0 ? raw : null;
  let scope: BrowseScope | null = null;
  if (rawAgent) {
    let roots: string[];
    try {
      roots = agentArtifactDirectories(coordRoot(), rawAgent);
    } catch {
      roots = [];
    }
    let agentName: string | null = null;
    try {
      // The manifest already carries the owner. A file page does not need to
      // rebuild the complete coordination projection to label one workspace.
      agentName = roots[0] ? ((await workspaceEntry(roots[0]))?.owner ?? null) : null;
    } catch {
      agentName = null;
    }
    // An empty owner scope must not silently show another agent's work.
    scope =
      roots.length > 0
        ? { label: `${agentName ?? "Agent"}'s artifacts`, roots }
        : { label: `No artifacts from ${agentName ?? "this agent"} yet`, roots: [] };
  } else if (rawDir) {
    // Strip leading "./" and surrounding slashes; the file API's resolver does
    // the real validation (denied / not_found render in the tree).
    const dir = rawDir.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
    if (dir) scope = { label: dir, roots: [dir] };
  }
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background">
      <NavBar scannedDir={coordRoot()} compact />
      <BrowseClient initialPath={initialPath} scope={scope} />
    </div>
  );
}
