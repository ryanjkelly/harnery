import type { AdapterCapabilities, AdapterProfile, CapabilityClaim } from "./types.ts";

const supported = (note?: string): CapabilityClaim => ({ support: "supported", note });
const unsupported = (note?: string): CapabilityClaim => ({ support: "unsupported", note });
const partial = (note: string): CapabilityClaim => ({ support: "partial", note });
const unknown = (note: string): CapabilityClaim => ({ support: "unknown", note });

function capabilities(overrides: Partial<AdapterCapabilities>): AdapterCapabilities {
  return {
    invocation: supported("Headless CLI subprocess."),
    modelSelection: supported("Explicit model flag is mapped by the adapter."),
    effortSelection: unsupported(),
    maxTurns: unsupported(),
    finalResult: supported("Normalized to SpawnResult.text."),
    sessionId: unsupported(),
    cost: unsupported(),
    toolEvidence: unsupported("The final-result adapter does not retain tool events."),
    policyMapping: unsupported("No ALLOW/DENY/ASK translation at the workflow boundary."),
    filesystemPolicyProjection: unsupported("The adapter declares no sandbox projection."),
    interruption: partial("Timeout kills the subprocess; no caller-driven interrupt handle."),
    streaming: unsupported("Workflow children return one normalized final result."),
    steering: unsupported("One prompt is fixed at subprocess launch."),
    resume: unsupported("Workflow children always start a new vendor session."),
    images: unsupported("SpawnRequest currently carries text only."),
    contextTelemetry: unknown("The workflow adapter does not expose live context usage."),
    preCompactionSignal: unknown("No compaction lifecycle probe has certified this adapter."),
    postCompactionSignal: unknown("No compaction lifecycle probe has certified this adapter."),
    compaction: unsupported("Harnery does not initiate native adapter compaction."),
    ...overrides,
  };
}

/** The one built-in profile catalog. Adding a fourth adapter starts here; CLI
 * choices, doctor metadata, workflow dispatch, and the bench derive from it. */
export const BUILTIN_ADAPTER_PROFILES = {
  "claude-code": {
    id: "claude-code",
    displayName: "Claude Code",
    binary: "claude",
    installHint: "npm install -g @anthropic-ai/claude-code",
    loginHint: "run `claude` and use /login",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    integrationMode: "cli-subprocess",
    authModel: "own-auth",
    modelFamily: "claude",
    effortValues: ["low", "medium", "high", "xhigh", "max"],
    verified: { date: "2026-08-18", version: "2.1.233 (Claude Code)" },
    capabilities: capabilities({
      effortSelection: supported("Mapped to `--effort <level>`."),
      maxTurns: supported("Mapped to `--max-turns <n>`."),
      sessionId: supported("Read from the JSON result envelope."),
      cost: supported("Read from total_cost_usd in the JSON result envelope."),
      contextTelemetry: partial(
        "Normalized when a hook payload reports context_window; no dedicated statusline bridge.",
      ),
      preCompactionSignal: supported("Claude Code PreCompact is wired to a durable checkpoint."),
      postCompactionSignal: supported(
        "SessionStart source=compact completes recovery and injects a verified briefing.",
      ),
    }),
  },
  codex: {
    id: "codex",
    displayName: "Codex",
    binary: "codex",
    installHint: "npm install -g @openai/codex",
    loginHint: "codex login",
    apiKeyEnv: "OPENAI_API_KEY",
    integrationMode: "cli-subprocess",
    authModel: "own-auth",
    modelFamily: "gpt",
    effortValues: ["none", "minimal", "low", "medium", "high", "xhigh"],
    verified: { date: "2026-08-04", version: "codex-cli 0.144.5" },
    // Verified against codex-cli 0.144.5: `--sandbox <mode>` plus
    // `sandbox_workspace_write.writable_roots`. Without the writable-root entry
    // a workspace-write child still cannot write a repository's .git directory.
    sandboxProjection: {
      modes: { "read-only": "read-only", "workspace-write": "workspace-write" },
      writableRoots: true,
    },
    capabilities: capabilities({
      effortSelection: supported('Mapped to `-c model_reasoning_effort="<level>"`.'),
      filesystemPolicyProjection: supported(
        "Mode renders to --sandbox; writable roots to sandbox_workspace_write.writable_roots.",
      ),
      maxTurns: unsupported("codex exec exposes no turn-ceiling flag."),
      sessionId: unsupported("--output-last-message carries no session id."),
      cost: unsupported("The final-message path carries no usage or cost."),
      contextTelemetry: partial(
        "Normalized when native hook payloads report context_window; unavailable otherwise.",
      ),
      preCompactionSignal: supported("Codex PreCompact is wired to a durable checkpoint."),
      postCompactionSignal: supported(
        "Codex PostCompact is observed; recovery is injected on the next submitted prompt.",
      ),
    }),
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor Agent",
    binary: "cursor-agent",
    installHint: "curl https://cursor.com/install -fsS | bash",
    loginHint: "cursor-agent login",
    apiKeyEnv: "CURSOR_API_KEY",
    integrationMode: "cli-subprocess",
    authModel: "own-auth",
    modelFamily: "multi",
    effortValues: [],
    verified: { date: "2026-08-18", version: "2026.08.11-e8db854" },
    capabilities: capabilities({
      effortSelection: unsupported(
        "Cursor embeds effort in some parameterized model ids; Harnery does not rewrite model ids.",
      ),
      maxTurns: unsupported("cursor-agent exposes no turn-ceiling flag."),
      sessionId: supported("Read from the JSON result envelope."),
      cost: unsupported("The JSON result envelope carries no cost."),
      contextTelemetry: unknown("No stable Cursor context-usage payload has been certified."),
      preCompactionSignal: supported("Cursor preCompact is wired to a durable checkpoint."),
      postCompactionSignal: unsupported(
        "Harnery does not wire an unverified Cursor postCompact hook.",
      ),
    }),
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    binary: "opencode",
    installHint: "curl -fsSL https://opencode.ai/install | bash",
    loginHint: "opencode auth login",
    apiKeyEnv: "OPENCODE_API_KEY",
    integrationMode: "cli-subprocess",
    authModel: "own-auth",
    modelFamily: "multi",
    // Model reasoning is selected through the `provider/model#variant` id;
    // OpenCode exposes no separate effort dial for Harnery to map.
    effortValues: [],
    verified: { date: "2026-09-20", version: "opencode v2.0.11" },
    capabilities: capabilities({
      effortSelection: unsupported(
        "OpenCode selects reasoning through the model id variant; there is no separate effort flag.",
      ),
      maxTurns: unsupported("`opencode run` exposes no turn-ceiling flag."),
      sessionId: supported("Read from the `sessionID` on every `--format json` NDJSON line."),
      cost: unsupported(
        "`opencode run --format json` streams parts without a final cost; cost lives in `session export`.",
      ),
      // Tool evidence is delivered on the event axis by the Harnery OpenCode
      // plugin, not by the final-result workflow spawn, which retains no tool
      // events (as with Codex and Cursor).
      contextTelemetry: unknown(
        "OpenCode stores context in SQLite; no context-window bridge is certified yet.",
      ),
      preCompactionSignal: supported(
        'OpenCode session.hook("compaction") is bridged to a durable checkpoint.',
      ),
      postCompactionSignal: unsupported(
        "No post-compact hook is wired; OpenCode post-compaction recovery is not yet certified.",
      ),
    }),
  },
} as const satisfies Record<string, AdapterProfile>;

export type BuiltinAdapterId = keyof typeof BUILTIN_ADAPTER_PROFILES;

export const BUILTIN_ADAPTER_IDS = Object.freeze(
  Object.keys(BUILTIN_ADAPTER_PROFILES) as BuiltinAdapterId[],
);

export function isBuiltinAdapter(id: string): id is BuiltinAdapterId {
  return Object.hasOwn(BUILTIN_ADAPTER_PROFILES, id);
}

export function builtinAdapterProfile(id: string): AdapterProfile | undefined {
  return isBuiltinAdapter(id) ? BUILTIN_ADAPTER_PROFILES[id] : undefined;
}

export function validateAdapterEffort(id: string, effort: string | undefined): void {
  if (!effort) return;
  const profile = builtinAdapterProfile(id);
  if (!profile) throw new Error(`unknown adapter ${JSON.stringify(id)}`);
  if (!profile.effortValues.includes(effort)) {
    const supportedValues = profile.effortValues.length ? profile.effortValues.join(", ") : "none";
    throw new Error(
      `effort ${JSON.stringify(effort)} is not supported by ${id}; supported values: ${supportedValues}`,
    );
  }
}
