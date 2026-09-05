import { serveFileThumbnail } from "@/lib/file-thumbnail";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request): Promise<Response> {
  return serveFileThumbnail(req);
}
