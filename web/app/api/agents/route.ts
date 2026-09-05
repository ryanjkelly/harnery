import { readDashboard } from "@/lib/dashboard-reader";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    return Response.json(await readDashboard("agents"));
  } catch {
    return Response.json(
      { error: "Agents temporarily unavailable" },
      {
        status: 503,
        headers: { "Retry-After": "1" },
      },
    );
  }
}
