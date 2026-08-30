import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default active-segment size that triggers automatic V3 epoch rotation. */
export const DEFAULT_EVENT_LEDGER_ROTATE_ACTIVE_BYTES = 32 * 1024 * 1024;

interface EventLedgerConfigFile {
  events?: { rotate_active_bytes?: unknown };
}

/** Strip JSONC comments without treating comment-like text inside strings as syntax. */
function stripJsonComments(input: string): string {
  let out = "";
  let index = 0;
  let inString = false;
  while (index < input.length) {
    const character = input[index];
    if (inString) {
      out += character;
      if (character === "\\" && index + 1 < input.length) {
        out += input[index + 1];
        index += 2;
        continue;
      }
      if (character === '"') inString = false;
      index++;
      continue;
    }
    if (character === '"') {
      inString = true;
      out += character;
      index++;
      continue;
    }
    if (character === "/" && input[index + 1] === "/") {
      while (index < input.length && input[index] !== "\n") index++;
      continue;
    }
    if (character === "/" && input[index + 1] === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) {
        index++;
      }
      index += 2;
      continue;
    }
    out += character;
    index++;
  }
  return out;
}

function readConfig(path: string): EventLedgerConfigFile {
  try {
    const parsed = JSON.parse(stripJsonComments(readFileSync(path, "utf8"))) as unknown;
    if (parsed && typeof parsed === "object") return parsed as EventLedgerConfigFile;
  } catch {
    // Missing or malformed config falls through to the next precedence layer.
  }
  return {};
}

function configuredThreshold(config: EventLedgerConfigFile): {
  present: boolean;
  value: unknown;
} {
  const events = config.events;
  if (!events || typeof events !== "object") return { present: false, value: undefined };
  return {
    present: Object.hasOwn(events, "rotate_active_bytes"),
    value: events.rotate_active_bytes,
  };
}

/**
 * Resolve the active-segment byte threshold without importing the host CLI's
 * configuration layer. Event V3 is vendored into clients as a closed runtime,
 * so this leaf reads only process state and JSONC files.
 */
export function resolveEventLedgerRotateActiveBytesV3(coordRoot: string | null): number {
  const env = process.env.HARNERY_EVENT_V3_ROTATE_ACTIVE_BYTES;
  if (env !== undefined) {
    const parsed = Number.parseInt(env, 10);
    if (Number.isFinite(parsed)) return parsed;
  }

  if (coordRoot) {
    const project = configuredThreshold(readConfig(join(coordRoot, ".harnery", "config.jsonc")));
    const xdg = process.env.XDG_CONFIG_HOME;
    const userBase = xdg?.trim() ? xdg : join(homedir(), ".config");
    const user = configuredThreshold(readConfig(join(userBase, "harnery", "config.jsonc")));
    const configured = project.present ? project.value : user.value;
    if (typeof configured === "number" && Number.isSafeInteger(configured)) return configured;
  }

  return DEFAULT_EVENT_LEDGER_ROTATE_ACTIVE_BYTES;
}
