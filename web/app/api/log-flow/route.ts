import { readLogFlowSnapshot } from "@/lib/log-flow-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET(): Response {
  return Response.json(readLogFlowSnapshot(), {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
