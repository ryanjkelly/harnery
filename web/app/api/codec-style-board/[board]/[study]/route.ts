/** Read-only, slug-validated PNG asset for the runtime Codec style board. */

import fs from "node:fs";

import { resolveCodecStyleStudy } from "@/lib/codec/style-board";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ board: string; study: string }> },
): Promise<Response> {
  const { board, study } = await params;
  const filePath = resolveCodecStyleStudy(board, study);
  if (!filePath) return new Response("not found", { status: 404 });
  try {
    const body = await fs.promises.readFile(filePath);
    return new Response(new Uint8Array(body), {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=3600",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
