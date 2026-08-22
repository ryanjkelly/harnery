import { BrowseClient, type BrowseScope } from "@/components/file-viewer/BrowseClient";
import { NavBar } from "@/components/NavBar";
import { ARTIFACTS_BROWSE_ROOT, agentArtifactDirectories } from "@/lib/artifact-browser";
import { coordRoot, readAgents } from "@/lib/coord-reader";
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
 *
 * `?agent=<instance-id>` SCOPES the tree: the agent's managed artifact
 * workspaces become the tree roots (newest first), so nothing outside them is
 * listed or size-walked — much cheaper than rooting at the repo. An agent with
 * no workspace yet falls back to the artifact root.
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
  let scope: BrowseScope | null = null;
  if (rawAgent) {
    let roots: string[];
    try {
      roots = agentArtifactDirectories(inventoryArtifacts(coordRoot()), rawAgent);
    } catch {
      roots = [];
    }
    if (roots.length === 0) roots = [ARTIFACTS_BROWSE_ROOT];
    let agentName: string | null = null;
    try {
      const snapshot = readAgents();
      agentName =
        [...snapshot.active, ...snapshot.stale, ...snapshot.terminal].find(
          (agent) => agent.instance_id === rawAgent || agent.v3_instance_id === rawAgent,
        )?.name ?? null;
    } catch {
      agentName = null;
    }
    scope = { agentName, roots };
  }
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background">
      <NavBar scannedDir={coordRoot()} />
      <BrowseClient initialPath={initialPath} scope={scope} />
    </div>
  );
}
