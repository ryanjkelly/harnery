import fs from "node:fs";

import { resolveCodecComprehensionAsset } from "@/lib/codec/comprehension";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ study: string; trial: string; side: string }> },
): Promise<Response> {
  const { study, trial, side } = await params;
  const asset = resolveCodecComprehensionAsset(study, trial, side);
  if (!asset) return new Response("not found", { status: 404 });
  try {
    const body = await fs.promises.readFile(asset.filePath);
    return new Response(new Uint8Array(body), {
      headers: {
        "content-type": asset.contentType,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
