import { readAgents } from "@/lib/coord-reader";

export const dynamic = "force-dynamic";

export function GET(): Response {
  const data = readAgents();
  return Response.json(data);
}
