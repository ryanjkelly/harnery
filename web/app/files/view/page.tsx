import { StandaloneFileViewer } from "@/components/file-viewer/StandaloneFileViewer";
import { NavBar } from "@/components/NavBar";
import { coordRoot } from "@/lib/coord-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "File · Harnery" };

/**
 * `/files/view?path=<rel>&mode=source|preview`: full-page standalone viewer
 * with dashboard chrome (Source | Preview). For a real browser document with
 * scripts enabled, open the isolated files origin instead
 * (`http://harnery-files.localhost:<port>/<path>` via the Eye action).
 */
export default async function FilesViewPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const rawPath = Array.isArray(sp.path) ? sp.path[0] : sp.path;
  const path = rawPath && rawPath.length > 0 ? rawPath : null;
  const rawMode = Array.isArray(sp.mode) ? sp.mode[0] : sp.mode;
  const initialMode = rawMode === "source" ? "source" : "preview";
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background">
      <NavBar scannedDir={coordRoot()} />
      <StandaloneFileViewer path={path} initialMode={initialMode} />
    </div>
  );
}
