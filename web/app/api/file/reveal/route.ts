import { NextResponse } from "next/server";
import { revealInNativeFileManager } from "@/lib/file-reveal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  let filePath = "";
  try {
    const body = (await req.json()) as { path?: unknown };
    filePath = typeof body.path === "string" ? body.path : "";
  } catch {
    // Malformed body is reported through the same stable error envelope.
  }
  if (!filePath) {
    return NextResponse.json(
      { error: "invalid_path", detail: "no path provided" },
      { status: 400 },
    );
  }
  const result = await revealInNativeFileManager(filePath);
  return result.ok
    ? NextResponse.json({ manager: result.manager })
    : NextResponse.json({ error: result.error, detail: result.detail }, { status: result.status });
}
