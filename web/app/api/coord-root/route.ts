import { coordRootId } from "../../../../src/lib/coord-root-id";
import { coordRoot } from "@/lib/coord-reader";

export function GET(): Response {
  return Response.json(
    { root_id: coordRootId(coordRoot()) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
