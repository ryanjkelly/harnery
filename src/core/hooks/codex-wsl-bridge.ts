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

export interface CodexWslWorkspaceLinkMapping {
  /** Absolute path seen by Linux-side tools. */
  linuxRoot: string;
  /** Forward-slash UNC path that Codex Desktop can use as a Markdown destination. */
  hostRoot: string;
  distro: string;
}

export interface CodexWslFileLinkTelemetry {
  /** Markdown destinations that still use the Linux root in a Windows-hosted WSL task. */
  wsl_linux_file_link_count: number;
  /** Bounded examples for local diagnosis; omitted when the count is zero. */
  wsl_linux_file_link_examples?: string[];
}

/** Whether an adapter-reported workspace is a Linux path exposed through WSL UNC. */
export function isWslUncPath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return (
    /^\\\\(?:wsl\.localhost|wsl\$)\\/i.test(value) ||
    /^\\\\\?\\unc\\(?:wsl\.localhost|wsl\$)\\/i.test(value)
  );
}

interface ParsedWslUncPath {
  host: string;
  distro: string;
  linuxPath: string;
}

function parseWslUncPath(value: unknown): ParsedWslUncPath | null {
  if (typeof value !== "string") return null;
  const ordinary = value.replace(/^\\\\\?\\UNC\\/i, "\\\\");
  const match = ordinary.match(/^\\\\(wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/i);
  if (!match) return null;
  const host = match[1]!;
  const distro = match[2]!;
  const tail = (match[3] ?? "").split("\\").filter(Boolean).join("/");
  return { host, distro, linuxPath: tail ? `/${tail}` : "/" };
}

function trimTrailingSlash(path: string): string {
  return path === "/" ? path : path.replace(/\/+$/, "");
}

function isWithinOrEqual(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Derive the Linux-to-host path pair from the actual adapter workspace. The
 * roots must overlap so an unrelated WSL UNC path cannot authorize a mapping
 * for some other checkout.
 */
export function codexWslWorkspaceLinkMapping(
  coordRootRaw: string,
  workspaceCwd: unknown,
): CodexWslWorkspaceLinkMapping | null {
  const parsed = parseWslUncPath(workspaceCwd);
  const linuxRoot = trimTrailingSlash(coordRootRaw.replace(/\\/g, "/"));
  if (!parsed || !linuxRoot.startsWith("/")) return null;
  const linuxCwd = trimTrailingSlash(parsed.linuxPath);
  if (!isWithinOrEqual(linuxCwd, linuxRoot) && !isWithinOrEqual(linuxRoot, linuxCwd)) {
    return null;
  }
  return {
    linuxRoot,
    hostRoot: `//${parsed.host}/${parsed.distro}${linuxRoot}`,
    distro: parsed.distro,
  };
}

/** Fresh adapter context for the model. Shell paths stay Linux-native; only
 * Markdown destinations use the host-visible root. */
export function renderCodexWslFileLinkContext(coordRoot: string, workspaceCwd: unknown): string {
  const mapping = codexWslWorkspaceLinkMapping(coordRoot, workspaceCwd);
  if (!mapping) return "";
  return (
    "Codex WSL file links: this task is hosted by Windows while tools run inside WSL. " +
    `For clickable local-file Markdown links, replace the Linux workspace root \`${mapping.linuxRoot}\` with the host-visible root \`${mapping.hostRoot}\`. ` +
    `Example: \`[label](<${mapping.hostRoot}/path/to/file>)\`. ` +
    "Keep Linux paths unchanged in shell commands and tool inputs."
  );
}

function withoutMarkdownCode(text: string): string {
  const output: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const candidate = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (candidate && candidate[1]![0] === fence.marker && candidate[1]!.length >= fence.length) {
        fence = null;
      }
      output.push("");
      continue;
    }
    if (candidate) {
      fence = { marker: candidate[1]![0]!, length: candidate[1]!.length };
      output.push("");
      continue;
    }
    output.push(line.replace(/(`+)([^`\n]*?)\1/g, ""));
  }
  return output.join("\n");
}

function markdownDestinations(text: string): string[] {
  const out: string[] = [];
  const visible = withoutMarkdownCode(text);
  const re = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))/g;
  for (const match of visible.matchAll(re)) {
    const target = match[1] ?? match[2];
    if (target) out.push(target);
  }
  return out;
}

/**
 * Count Markdown links that point at the Linux workspace root even though the
 * adapter workspace is Windows-visible UNC. This is telemetry only: the Stop
 * hook must not replace or retry an otherwise complete Codex reply.
 */
export function codexWslFileLinkTelemetry(
  coordRoot: string,
  workspaceCwd: unknown,
  assistantMessage: string,
): CodexWslFileLinkTelemetry | null {
  const mapping = codexWslWorkspaceLinkMapping(coordRoot, workspaceCwd);
  if (!mapping) return null;
  const mismatches = markdownDestinations(assistantMessage).filter((target) =>
    isWithinOrEqual(target, mapping.linuxRoot),
  );
  return {
    wsl_linux_file_link_count: mismatches.length,
    ...(mismatches.length > 0
      ? { wsl_linux_file_link_examples: mismatches.slice(0, 3).map((path) => path.slice(0, 240)) }
      : {}),
  };
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
