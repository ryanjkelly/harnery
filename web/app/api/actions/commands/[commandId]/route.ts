import { coordRoot } from "@/lib/coord-reader";
import { validCommandId } from "@/lib/dashboard-command-protocol";
import { readDashboardCommand } from "@/lib/dashboard-command-store";

export const dynamic = "force-dynamic";
export async function GET(
  _req: Request,
  context: { params: Promise<{ commandId: string }> },
): Promise<Response> {
  const { commandId } = await context.params;
  if (!validCommandId(commandId))
    return Response.json({ error: "invalid_command_id" }, { status: 400 });
  try {
    const receipt = readDashboardCommand(coordRoot(), commandId);
    return receipt
      ? Response.json(receipt)
      : Response.json({ error: "command_not_found" }, { status: 404 });
  } catch {
    return Response.json({ error: "command_receipt_unreadable" }, { status: 503 });
  }
}
