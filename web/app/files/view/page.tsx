import { StandaloneFileViewer } from "@/components/file-viewer/StandaloneFileViewer";
import { NavBar } from "@/components/NavBar";
import { coordRoot } from "@/lib/coord-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "File · Harnery" };

/**
 * `/files/view?path=<rel>&mode=source|preview`: full-page standalone viewer.
 * Distinct from `/files?path=` (modal overlay on the landing page) so "Open
 * preview in new tab" can render HTML without making `/api/file` navigable as
 * text/html. The root FileViewerProvider skips auto-open on this pathname.
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
