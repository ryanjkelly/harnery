/**
 * Tunnels as registry services.
 *
 * `tunnel up` and `tunnel reload` register the instance; `tunnel down`
 * removes it. Tunnels started before the registry existed are adopted the next
 * time the registry is read, so a long-lived tunnel never shows as an
 * unregistered listener.
 */

import { resolve } from "node:path";
import { gateLogFile, type TunnelState } from "../../lib/tunnel/state.ts";
import { resolveBinName } from "../config.ts";
import type { RegisterServerInput } from "./index.ts";

export function tunnelServerId(name: string): string {
  return `tunnel-${name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
}

/** The registry input for one tunnel instance. */
export function tunnelServerInput(state: TunnelState, coordRoot: string): RegisterServerInput {
  const helpers = [state.cloudflared_pid, state.provider_pid].filter(
    (pid): pid is number => typeof pid === "number" && pid > 0,
  );
  return {
    id: tunnelServerId(state.name),
    kind: "service",
    type: "tunnel",
    label: `Tunnel ${state.name} → ${state.target}${state.vhost ? ` (${state.vhost})` : ""}`,
    url: state.url,
    port: state.gate_port,
    pid: state.gate_pid,
    ...(helpers.length ? { pids: helpers } : {}),
    log: resolve(coordRoot, ".cache", "tunnel", gateLogFile(state.name)),
    cwd: coordRoot,
    stop_argv: [resolveBinName(coordRoot), "tunnel", "down", "--name", state.name],
    started_at: state.started_at,
    owner: null,
  };
}
