export interface CodexWslBridgeStatus {
  ok: boolean;
  detail: string;
  threadIdPresent: boolean;
  wslenvForwardsThreadId: boolean;
}

export interface CodexWslBridgeOptions {
  /** The caller already knows this is a Codex adapter process. */
  expected?: boolean;
}

/** Whether an adapter-reported workspace is a Linux path exposed through WSL UNC. */
export function isWslUncPath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return (
    /^\\\\(?:wsl\.localhost|wsl\$)\\/i.test(value) ||
    /^\\\\\?\\unc\\(?:wsl\.localhost|wsl\$)\\/i.test(value)
  );
}

function wslenvForwards(wslenv: string | undefined, variable: string): boolean {
  if (!wslenv) return false;
  return wslenv.split(":").some((entry) => entry.split("/", 1)[0] === variable);
}

/**
 * Inspect the environment contract used when Windows-native Codex launches a
 * Harnery hook or shell inside WSL. Returns null outside that hybrid mode.
 */
export function inspectCodexWslBridge(
  env: NodeJS.ProcessEnv = process.env,
  options: CodexWslBridgeOptions = {},
): CodexWslBridgeStatus | null {
  const inWsl = Boolean(env.WSL_DISTRO_NAME?.trim() || env.WSL_INTEROP?.trim());
  if (!inWsl) return null;

  const threadIdPresent = Boolean(env.CODEX_THREAD_ID?.trim());
  const wslenvForwardsThreadId = wslenvForwards(env.WSLENV, "CODEX_THREAD_ID");
  if (!options.expected && !threadIdPresent && !wslenvForwardsThreadId) return null;

  const problems: string[] = [];
  if (!threadIdPresent) problems.push("CODEX_THREAD_ID did not reach WSL");
  if (!wslenvForwardsThreadId) problems.push("WSLENV does not forward CODEX_THREAD_ID");

  const distro = env.WSL_DISTRO_NAME?.trim();
  return {
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `thread identity forwarded through WSLENV${distro ? ` (${distro})` : ""}`
        : problems.join("; "),
    threadIdPresent,
    wslenvForwardsThreadId,
  };
}
