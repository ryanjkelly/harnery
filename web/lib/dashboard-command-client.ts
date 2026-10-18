import {
  type CommandArguments,
  type CommandIntent,
  type CommandReceipt,
  canonicalCommand,
  commandTarget,
  type DashboardAction,
  isCommandReceipt,
  validCommandId,
} from "./dashboard-command-protocol";

export type CommandStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem">;
interface Retained {
  intent: CommandIntent;
  receipt?: CommandReceipt;
}
export function dashboardCommandClient(
  root: string,
  action: DashboardAction,
  target: CommandArguments,
  storage: () => CommandStorage = () => window.localStorage,
  send: typeof fetch = (...args) => fetch(...args),
) {
  const prefix = `harnery.dashboard-command.v1:${encodeURIComponent(canonicalCommand([root, action, target]))}:`;
  function records(): Retained[] {
    const s = storage(),
      result: Retained[] = [];
    for (let n = 0; n < s.length; n++) {
      const key = s.key(n);
      if (!key?.startsWith(prefix)) continue;
      const r = JSON.parse(s.getItem(key)!) as Retained;
      if (
        !validCommandId(r?.intent?.command_id) ||
        r.intent.project_root !== root ||
        r.intent.action !== action ||
        canonicalCommand(commandTarget(action, r.intent.arguments)) !== canonicalCommand(target)
      )
        throw new Error("Retained command is unreadable; no new action was sent.");
      if (r.receipt !== undefined && !isCommandReceipt(r.receipt, r.intent))
        throw new Error(
          "Retained receipt does not confirm its original command; no new action was sent.",
        );
      result.push(r);
    }
    return result;
  }
  function save(record: Retained): void {
    const s = storage(),
      key = prefix + record.intent.command_id,
      text = JSON.stringify(record);
    s.setItem(key, text);
    if (s.getItem(key) !== text)
      throw new Error("Command could not be retained; no new action was sent.");
  }
  async function accept(response: Response, record: Retained): Promise<CommandReceipt> {
    const receipt: unknown = await response.json();
    if (!isCommandReceipt(receipt, record.intent))
      throw new Error("Original command outcome could not be confirmed; intent retained.");
    save({ ...record, receipt });
    return receipt;
  }
  async function reconcile(record: Retained): Promise<CommandReceipt | null> {
    const response = await send(
      `/api/actions/commands/${encodeURIComponent(record.intent.command_id)}`,
    );
    if (response.status === 404) return null; // Retain the original ID and arguments.
    return accept(response, record);
  }
  return {
    async recover(): Promise<CommandReceipt | null> {
      const all = records();
      const pending = all.filter((r) => r.receipt?.state !== "settled");
      let last: CommandReceipt | null = null;
      let unconfirmed: CommandReceipt | null = null;
      // No unconfirmed record is replaced, even if another tab created one.
      for (const r of pending.length ? pending : all.slice(-1)) {
        last = await reconcile(r);
        if (!last && r.receipt?.state !== "settled") {
          unconfirmed = {
            ...r.intent,
            state: "unknown",
            reason:
              "No server receipt is available; the original command is retained for explicit retry.",
          };
        } else if (last && last.state !== "settled") unconfirmed = last;
      }
      return unconfirmed ?? last;
    },
    async submit(args: CommandArguments): Promise<CommandReceipt> {
      if (!root || canonicalCommand(commandTarget(action, args)) !== canonicalCommand(target))
        throw new Error("Project or command target differs; no action was sent.");
      const pending = records().filter((r) => r.receipt?.state !== "settled");
      if (pending.length > 1)
        throw new Error(
          "Multiple unconfirmed commands are retained; reconcile them before sending another.",
        );
      let record = pending[0];
      if (record) {
        if (canonicalCommand(record.intent.arguments) !== canonicalCommand(args))
          throw new Error(
            "An earlier command is unconfirmed; its original arguments are retained.",
          );
        const recovered = await reconcile(record);
        if (recovered) return recovered;
      } else {
        record = {
          intent: { command_id: crypto.randomUUID(), project_root: root, action, arguments: args },
        };
        save(record); // Required before the first request, never just component state.
      }
      return accept(
        await send(`/api/actions/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command_id: record.intent.command_id,
            project_root: root,
            ...record.intent.arguments,
          }),
        }),
        record,
      );
    },
  };
}
