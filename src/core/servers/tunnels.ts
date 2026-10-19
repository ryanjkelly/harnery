/**
 * Tunnels as registry services.
 *
 * `tunnel up` and `tunnel reload` register the new gate; `tunnel down` removes
 * its record. Missing original witnesses remain unknown and cannot authorize actions.
 */

import { hostname } from "node:os";
import { resolve } from "node:path";
import {
  gateLogFile,
  type TunnelReadinessVerifier,
  type TunnelState,
} from "../../lib/tunnel/state.ts";
import {
  type RegisterServerInput,
  readServer,
  type ServerOptions,
  verifyProcessGeneration,
  withServerRegistrationCustody,
} from "./index.ts";

/** Verify only witnesses saved by the original tunnel registration. */
export function createTunnelReadinessVerifier(options: ServerOptions): TunnelReadinessVerifier {
  return {
    observeProcess(pid, originalToken) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") return "absent";
        return "unknown";
      }
      return verifyProcessGeneration(pid, originalToken);
    },
    withRegistration(state, inspect) {
      try {
        const original = readServer(tunnelServerId(state.name), options);
        if (
          !original ||
          original.host !== hostname() ||
          original.kind !== "service" ||
          original.type !== "tunnel" ||
          original.registration_id !== state.registration_id ||
          original.pid !== state.gate_pid ||
          original.start_token !== state.gate_start_token ||
          original.port !== state.gate_port ||
          original.url !== state.url
        )
          return "unknown";
        return withServerRegistrationCustody(original, options, inspect);
      } catch {
        return "unknown";
      }
    },
  };
}

export function tunnelServerId(name: string): string {
  return `tunnel-${name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
}

/** Register the new gate; saved helper PIDs have no generation witnesses. */
export function tunnelServerInput(state: TunnelState, coordRoot: string): RegisterServerInput {
  if (Object.hasOwn(state, "provider_pid") || Object.hasOwn(state, "provider_start_token"))
    throw new Error("obsolete tunnel provider authority is unknown; state retained");
  if (!state.gate_start_token)
    throw new Error("tunnel gate generation witness is unavailable; state retained");
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
