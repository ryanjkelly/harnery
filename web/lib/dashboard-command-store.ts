/** Durable dashboard custody; these receipts never authorize redispatch. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  type CommandArguments,
  type CommandIntent,
  type CommandReceipt,
  canonicalCommand,
  DASHBOARD_ACTIONS,
  type DashboardAction,
  isCommandReceipt,
  sameIntent,
  validCommandId,
} from "./dashboard-command-protocol";

const active = new Set<string>();
function directory(root: string): string {
  const dir = path.join(root, ".harnery", "dashboard-commands");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
function syncDirectory(dir: string): void {
  // Windows does not expose directory fsync. File fsync and exclusive creation
  // still protect dispatch; an unavailable directory sync on POSIX refuses it.
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function durableWrite(file: string, value: unknown, exclusive = false): void {
  const destination = exclusive ? file : `${file}.${randomUUID()}.tmp`;
  const fd = openSync(destination, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!exclusive) renameSync(destination, file);
  syncDirectory(path.dirname(file));
}
function files(root: string, id: string) {
  if (!validCommandId(id)) throw new Error("invalid_command_id");
  const base = path.join(directory(root), id);
  return {
    claim: `${base}.intent.json`,
    settled: `${base}.settled.json`,
    unknown: `${base}.unknown.json`,
  };
}
function digest(intent: CommandIntent): string {
  return createHash("sha256").update(canonicalCommand(intent)).digest("hex");
}
function readIntent(root: string, id: string): CommandIntent | null {
  const p = files(root, id);
  if (!existsSync(p.claim)) return null;
  const record = JSON.parse(readFileSync(p.claim, "utf8")) as {
    intent: CommandIntent;
    digest: string;
  };
  const i = record.intent;
  if (
    !i ||
    i.command_id !== id ||
    i.project_root !== root ||
    !DASHBOARD_ACTIONS.includes(i.action) ||
    !i.arguments ||
    typeof i.arguments !== "object" ||
    record.digest !== digest(i)
  )
    throw new Error("command_receipt_unreadable");
  return i;
}
export function readDashboardCommand(root: string, id: string): CommandReceipt | null {
  const intent = readIntent(root, id);
  if (!intent) return null;
  const p = files(root, id);
  if (existsSync(p.unknown))
    return {
      ...intent,
      state: "unknown",
      reason: "Action outcome is unconfirmed; retained command must not be reapplied.",
    };
  if (existsSync(p.settled)) {
    const settled: unknown = JSON.parse(readFileSync(p.settled, "utf8"));
    if (!isCommandReceipt(settled, intent) || settled.state !== "settled")
      throw new Error("command_receipt_unreadable");
    return settled;
  }
  return {
    ...intent,
    state: active.has(p.claim) ? "pending" : "unknown",
    reason: active.has(p.claim)
      ? "Original command is still running."
      : "Original worker has not confirmed the outcome; command will not be reapplied.",
  };
}
export class CommandConflict extends Error {}
export async function dashboardActionResponse(
  root: string,
  action: DashboardAction,
  body: unknown,
  args: CommandArguments,
  effect: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<Response> {
  const raw = body as Record<string, unknown>;
  if (!validCommandId(raw?.command_id) || raw?.project_root !== root) {
    return Response.json(
      { error: "command_identity_required", required: ["command_id", "project_root"] },
      { status: 400 },
    );
  }
  if (
    Object.keys(raw).some(
      (key) => !["command_id", "project_root", ...Object.keys(args)].includes(key),
    )
  ) {
    return Response.json({ error: "unexpected_command_arguments" }, { status: 400 });
  }
  try {
    const receipt = await executeDashboardCommand(
      root,
      { command_id: raw.command_id, project_root: root, action, arguments: args },
      effect,
    );
    return Response.json(receipt, {
      status: receipt.state === "settled" ? 200 : receipt.state === "pending" ? 202 : 409,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof CommandConflict ? error.message : "command_receipt_unavailable" },
      { status: error instanceof CommandConflict ? 409 : 503 },
    );
  }
}
export async function executeDashboardCommand(
  root: string,
  intent: CommandIntent,
  effect: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<CommandReceipt> {
  const p = files(root, intent.command_id);
  try {
    durableWrite(p.claim, { intent, digest: digest(intent) }, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const original = readIntent(root, intent.command_id);
    if (!original || !sameIntent(original, intent))
      throw new CommandConflict("command_id_reused_with_different_arguments");
    return readDashboardCommand(root, intent.command_id)!;
  }
  active.add(p.claim);
  try {
    const result = await effect();
    const receipt: CommandReceipt = { ...intent, state: "settled", result };
    durableWrite(p.settled, receipt);
    return receipt;
  } catch {
    // Throwing does not establish that an effect did not happen. Nor does a
    // pending claim left by a dead worker. Neither path may invoke it again.
    durableWrite(p.unknown, { state: "unknown" });
    return {
      ...intent,
      state: "unknown",
      reason: "Action outcome is unconfirmed; command will not be reapplied.",
    };
  } finally {
    active.delete(p.claim);
  }
}
