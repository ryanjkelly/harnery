/**
 * Tunnels as registry services.
 *
 * `tunnel up` and `tunnel reload` register the new gate; `tunnel down` removes
 * its record. Older tunnels need an explicit adoption of an observed listener.
 */

import { resolve } from "node:path";
import { gateLogFile, type TunnelState } from "../../lib/tunnel/state.ts";
import type { RegisterServerInput } from "./index.ts";

export function tunnelServerId(name: string): string {
  return `tunnel-${name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
}

/** Register the new gate; saved helper PIDs have no generation witnesses. */
export function tunnelServerInput(state: TunnelState, coordRoot: string): RegisterServerInput {
  if (!state.gate_start_token)
    throw new Error("tunnel gate generation witness is unavailable; explicit adoption is required");
  return {
    id: tunnelServerId(state.name),
    kind: "service",
    type: "tunnel",
    label: `Tunnel ${state.name} → ${state.target}${state.vhost ? ` (${state.vhost})` : ""}`,
    url: state.url,
    port: state.gate_port,
    pid: state.gate_pid,
    start_token: state.gate_start_token,
    log: resolve(coordRoot, ".cache", "tunnel", gateLogFile(state.name)),
    cwd: coordRoot,
    started_at: state.started_at,
    owner: null,
  };
}
