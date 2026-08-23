/**
 * Path-shaped sandboxed file tree for full-tab HTML review. Keeping the repo
 * path in the browser URL means relative images, stylesheets, fonts, media,
 * and links resolve beside their source document. The shared file resolver
 * still owns allowlisting, inode pinning, MIME, range, and sandbox headers.
 */

import { serveRawFile } from "@/lib/file-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, ctx: RouteContext): Promise<Response> {
  const { path } = await ctx.params;
  return serveRawFile(req, { pathOverride: path.join("/"), renderTree: true });
}

export async function HEAD(req: Request, ctx: RouteContext): Promise<Response> {
  const { path } = await ctx.params;
  return serveRawFile(req, {
    headOnly: true,
    pathOverride: path.join("/"),
    renderTree: true,
  });
}
