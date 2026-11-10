/**
 * Billing-mode probe: which auth a headless adapter child will actually use.
 *
 * The engine never handles credentials — children are plain adapter CLIs and
 * authenticate however that CLI does. But the CLIs prefer an exported API key
 * over a stored (subscription) login when both are present, and that override
 * is almost always an accident: a sourced .env or a leftover export silently
 * moves the run from subsidized subscription billing to per-token API billing.
 * This probe classifies the state per adapter so the engine can refuse the
 * silent-override case (see decision 0015 addendum) while leaving deliberate
 * key-only hosts (CI boxes with no login) working.
 *
 * Detection is a heuristic over well-known credential locations; when a
 * location can't prove presence or absence (e.g. Claude Code stores its OAuth
 * token in the macOS keychain, not a file), the state is "unknown" and the
 * engine never hard-fails on it — the adapter CLI itself is the final
 * authority and will error loudly if truly unauthenticated.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterName } from "./types.ts";

/** The env var each adapter CLI reads as an API key (preferred over a stored
 * login when set). Shared with the child-env builder's subscription-only
 * scrub. */
export const API_KEY_VARS: Record<string, string> = {
  "claude-code": "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
  cursor: "CURSOR_API_KEY",
};

export type LoginState = "present" | "absent" | "unknown";

export type BillingMode =
  /** No API key exported; the child rides the stored (subscription) login. */
  | "subscription"
  /** API key present, no stored login detected: a deliberate key-only host. */
  | "api-key"
  /** API key present AND a stored login exists: the key silently overrides
   * subsidized auth. The engine refuses this unless explicitly allowed. */
  | "api-key-override";

export interface BillingProbe {
  adapter: AdapterName;
  /** The env var checked (from API_KEY_VARS), or a note when the key was
   * found in a credential file instead of the environment. */
  apiKeySource: string | null;
  apiKeyPresent: boolean;
  login: LoginState;
  mode: BillingMode;
}

export interface ProbeIo {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export type BillingProber = (adapter: AdapterName) => BillingProbe;

export function probeBilling(adapter: AdapterName, io: ProbeIo = {}): BillingProbe {
  const env = io.env ?? process.env;
  const home = io.home ?? homedir();
  const keyVar = API_KEY_VARS[adapter];
  const envKey = keyVar ? Boolean(env[keyVar]?.trim()) : false;

  let login: LoginState;
  let apiKeyPresent = envKey;
  let apiKeySource: string | null = envKey ? keyVar : null;

  switch (adapter) {
    case "claude-code":
      login = probeClaudeLogin(home);
      break;
    case "codex": {
      const codex = probeCodexAuth(env, home);
      login = codex.login;
      // `codex login --api-key` stores the key in auth.json rather than the
      // env; that is still API-key billing and should surface as such.
      if (!envKey && codex.storedApiKey) {
        apiKeyPresent = true;
        apiKeySource = codex.storedApiKeyNote;
      }
      break;
    }
    case "cursor":
      login = probeCursorLogin(env, home);
      break;
    default:
      // External adapters own their authentication. The generic engine must
      // not guess credential locations or fail a plugin on a built-in-only
      // heuristic.
      login = "unknown";
      break;
  }

  const mode: BillingMode =
    apiKeyPresent && login === "present"
      ? "api-key-override"
      : apiKeyPresent
        ? "api-key"
        : "subscription";

  return { adapter, apiKeySource, apiKeyPresent, login, mode };
}

/** Claude Code: OAuth login lives at ~/.claude/.credentials.json on Linux;
 * macOS stores it in the keychain (dir exists, file doesn't → unknown). */
function probeClaudeLogin(home: string): LoginState {
  const dir = join(home, ".claude");
  const credFile = join(dir, ".credentials.json");
  if (existsSync(credFile)) {
    try {
      const parsed = JSON.parse(readFileSync(credFile, "utf8")) as {
        claudeAiOauth?: { accessToken?: string };
      };
      return parsed.claudeAiOauth?.accessToken ? "present" : "absent";
    } catch {
      return "unknown";
    }
  }
  return existsSync(dir) ? "unknown" : "absent";
}

/**
 * cursor-agent: the stored login is `auth.json` holding `accessToken` and
 * `refreshToken`. The path follows the CLI's own resolution, read from the
 * installed 2026.09.18 build: `$CURSOR_CONFIG_DIR` when set, else
 * `%APPDATA%\\cursor` on Windows, `~/.cursor` on macOS, and
 * `$XDG_CONFIG_HOME/cursor` (default `~/.config/cursor`) elsewhere.
 * `cursor-agent status --format json` reports the same two tokens as
 * `hasAccessToken` / `hasRefreshToken`.
 */
function probeCursorLogin(env: NodeJS.ProcessEnv, home: string): LoginState {
  const authPath = join(cursorConfigDir(env, home), "auth.json");
  if (!existsSync(authPath)) return "absent";
  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8")) as {
      accessToken?: string;
      refreshToken?: string;
    };
    return parsed.accessToken?.trim() || parsed.refreshToken?.trim() ? "present" : "absent";
  } catch {
    return "unknown";
  }
}

function cursorConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  const override = env.CURSOR_CONFIG_DIR?.trim();
  if (override) return override;
  const platform = env.HARNERY_BILLING_PLATFORM?.trim() || process.platform;
  if (platform === "win32")
    return join(env.APPDATA?.trim() || join(home, "AppData", "Roaming"), "cursor");
  if (platform === "darwin") return join(home, ".cursor");
  return join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "cursor");
}

/** codex: auth lives at $CODEX_HOME/auth.json (default ~/.codex). A `tokens`
 * object means a ChatGPT (subscription) login; an OPENAI_API_KEY field means
 * a stored API key (`codex login --api-key`). */
function probeCodexAuth(
  env: NodeJS.ProcessEnv,
  home: string,
): { login: LoginState; storedApiKey: boolean; storedApiKeyNote: string } {
  const authPath = join(env.CODEX_HOME?.trim() || join(home, ".codex"), "auth.json");
  const storedApiKeyNote = `${authPath} (stored key)`;
  if (!existsSync(authPath)) return { login: "absent", storedApiKey: false, storedApiKeyNote };
  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8")) as {
      tokens?: unknown;
      OPENAI_API_KEY?: string | null;
    };
    return {
      login: parsed.tokens ? "present" : "absent",
      storedApiKey: !parsed.tokens && Boolean(parsed.OPENAI_API_KEY),
      storedApiKeyNote,
    };
  } catch {
    return { login: "unknown", storedApiKey: false, storedApiKeyNote };
  }
}
