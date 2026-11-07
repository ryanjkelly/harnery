import { NextResponse } from "next/server";
import { runHarn } from "@/lib/run-harn";

/**
 * Write-side for the Cursor API key. Shells the host CLI
 * (`harnery/bin/harn devtools cursor-key set|clear`) rather than writing the
 * key file directly, so the storage path + 0600 semantics stay in one place.
 * POST { key } stores it; DELETE clears it.
 */

export async function POST(req: Request): Promise<NextResponse> {
  let key = "";
  try {
    const body = (await req.json()) as { key?: unknown };
    key = typeof body.key === "string" ? body.key.trim() : "";
  } catch {
    // malformed body → key stays empty
  }
  if (!key) {
    return NextResponse.json({ ok: false, error: "no key provided" }, { status: 400 });
  }
  // Pass the key on stdin so it never appears in argv / the process list.
  const res = await runHarn(["devtools", "cursor-key", "set"], { stdin: key });
  return res.ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ ok: false, error: res.stderr || "failed to store key" }, { status: 500 });
}

export async function DELETE(): Promise<NextResponse> {
  const res = await runHarn(["devtools", "cursor-key", "clear"]);
  return res.ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ ok: false, error: res.stderr || "failed to clear key" }, { status: 500 });
}
