import { readDashboard } from "@/lib/dashboard-reader";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const started = performance.now();
  try {
    const body = await readDashboard("palette");
    return Response.json(body, {
      headers: { "Server-Timing": `reader;dur=${(performance.now() - started).toFixed(1)}` },
    });
  } catch {
    return Response.json(
      { error: "Catalog temporarily unavailable" },
      {
        status: 503,
        headers: { "Retry-After": "1" },
      },
    );
  }
}
