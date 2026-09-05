import { listWorkspaces } from "@/lib/browse-catalog";
import { fileErrorResponse } from "@/lib/file-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const result = await listWorkspaces();
  if (!result.ok) return fileErrorResponse(result);
  return Response.json(
    { entries: result.entries, partial: result.partial },
    {
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    },
  );
}
