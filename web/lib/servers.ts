/**
 * Local server registry, read and stopped through `harn servers` so the
 * dashboard and the CLI share one implementation.
 */

import type { ServersReport } from "../../src/core/servers";
import { runHarn } from "./run-harn";

export type { ServersReport, ServerView, UnregisteredListener } from "../../src/core/servers";

export async function readServersReport(): Promise<{ report?: ServersReport; error?: string }> {
  const result = await runHarn(["servers", "list", "--json"]);
  try {
    return { report: JSON.parse(result.stdout) as ServersReport };
  } catch {
    return { error: result.stderr.trim() || "could not read the server registry" };
  }
}

const SERVER_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;

export async function stopServerByRef(
  ref: { id: string } | { pid: number },
): Promise<{ ok: boolean; message: string }> {
  const args =
    "id" in ref
      ? SERVER_ID.test(ref.id)
        ? ["servers", "stop", ref.id, "--json"]
        : null
      : Number.isSafeInteger(ref.pid) && ref.pid > 0
        ? ["servers", "stop", "--pid", String(ref.pid), "--json"]
        : null;
  if (!args) return { ok: false, message: "invalid server reference" };
  const result = await runHarn(args);
  const failure = (): string => {
    try {
      const parsed = JSON.parse(result.stderr.trim()) as { error?: { message?: string } };
      if (parsed.error?.message) return parsed.error.message;
    } catch {
      // stderr is plain text
    }
    return result.stderr.trim() || "stop failed";
  };
  try {
    const parsed = JSON.parse(result.stdout) as {
      results?: Array<{ stopped?: boolean; method?: string; detail?: string }>;
    };
    const first = parsed.results?.[0];
    if (first?.stopped || first?.method === "not-running")
      return { ok: true, message: first.stopped ? "Stopped." : "It had already stopped." };
    return { ok: false, message: first?.detail ?? failure() };
  } catch {
    return { ok: false, message: failure() };
  }
}
