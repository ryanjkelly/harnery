/** The dashboard's single command/receipt contract. Browser-safe. */
export const DASHBOARD_ACTIONS = ["ping", "end-session", "release-claim", "stop-server"] as const;
export type DashboardAction = (typeof DASHBOARD_ACTIONS)[number];
export type CommandArguments = Record<string, string | number>;
export interface CommandIntent {
  command_id: string;
  project_root: string;
  action: DashboardAction;
  arguments: CommandArguments;
}
export interface CommandReceipt extends CommandIntent {
  state: "pending" | "settled" | "unknown";
  result?: Record<string, unknown>;
  reason?: string;
}
export function canonicalCommand(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalCommand).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalCommand(v)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("invalid_command_value");
  return encoded;
}
export function validCommandId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
export function commandTarget(action: DashboardAction, args: CommandArguments): CommandArguments {
  if (action === "stop-server") return "id" in args ? { id: args.id } : { pid: args.pid };
  return action === "release-claim"
    ? { instance_id: args.instance_id, path: args.path }
    : { instance_id: args.instance_id };
}
export function sameIntent(a: CommandIntent, b: CommandIntent): boolean {
  return canonicalCommand(a) === canonicalCommand(b);
}

export function isCommandReceipt(value: unknown, original: CommandIntent): value is CommandReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { state, result, reason, ...intent } = value as CommandReceipt;
  if (!["pending", "settled", "unknown"].includes(state)) return false;
  if (reason !== undefined && typeof reason !== "string") return false;
  if (state === "settled" && (!result || typeof result !== "object" || Array.isArray(result)))
    return false;
  if (state !== "settled" && result !== undefined) return false;
  try {
    return sameIntent(intent, original);
  } catch {
    return false;
  }
}
