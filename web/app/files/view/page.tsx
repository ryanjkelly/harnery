import { StandaloneFileViewer } from "@/components/file-viewer/StandaloneFileViewer";
import { PageShell } from "@/components/layout/PageShell";

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
      {/* The viewer draws its own edge-to-edge header and panes, so the shell drops its gutter. */}
      <PageShell width="fill" compactNav={false} className="px-0 pb-0 sm:px-0">
        <StandaloneFileViewer path={path} initialMode={initialMode} />
      </PageShell>
    </div>
  );
}
