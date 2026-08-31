import { NextResponse } from "next/server";

import { coordRoot } from "@/lib/coord-reader";
import { diagnosticsVersion } from "@/lib/diagnostics-reader";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { v: diagnosticsVersion(coordRoot()) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
