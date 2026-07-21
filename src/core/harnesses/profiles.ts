import type { CapabilityClaim, HarnessCapabilities, HarnessProfile } from "./types.ts";

const supported = (note?: string): CapabilityClaim => ({ support: "supported", note });
const unsupported = (note?: string): CapabilityClaim => ({ support: "unsupported", note });
const partial = (note: string): CapabilityClaim => ({ support: "partial", note });
const unknown = (note: string): CapabilityClaim => ({ support: "unknown", note });

function capabilities(overrides: Partial<HarnessCapabilities>): HarnessCapabilities {
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
    interruption: partial("Timeout kills the subprocess; no caller-driven interrupt handle."),
    streaming: unsupported("Workflow children return one normalized final result."),
    steering: unsupported("One prompt is fixed at subprocess launch."),
    resume: unsupported("Workflow children always start a new vendor session."),
    images: unsupported("SpawnRequest currently carries text only."),
    contextTelemetry: unknown("The workflow adapter does not expose live context usage."),
    preCompactionSignal: unknown("No compaction lifecycle probe has certified this adapter."),
    postCompactionSignal: unknown("No compaction lifecycle probe has certified this adapter."),
    compaction: unsupported("Harnery does not initiate native harness compaction."),
    ...overrides,
  };
}

/** The one built-in profile catalog. Adding a fourth harness starts here; CLI
 * choices, doctor metadata, workflow dispatch, and the bench derive from it. */
export const BUILTIN_HARNESS_PROFILES = {
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
    verified: { date: "2026-07-20", version: "current CLI contract" },
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
    verified: { date: "2026-07-21", version: "codex-cli 0.145.0-alpha.18" },
    capabilities: capabilities({
      effortSelection: supported('Mapped to `-c model_reasoning_effort="<level>"`.'),
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
    verified: { date: "2026-07-21", version: "2026.07.16-899851b" },
    capabilities: capabilities({
      effortSelection: unsupported(
        "Cursor embeds effort in some parameterized model ids; Harnery does not rewrite model ids.",
      ),
      maxTurns: unsupported("cursor-agent exposes no turn-ceiling flag."),
      sessionId: supported("Read from the JSON result envelope."),
      cost: unsupported("The JSON result envelope carries no cost."),
      contextTelemetry: unknown("No stable Cursor context-usage payload has been certified."),
      preCompactionSignal: unsupported(
        "Harnery does not wire an unverified Cursor preCompact hook.",
      ),
      postCompactionSignal: unsupported(
        "Harnery does not wire an unverified Cursor postCompact hook.",
      ),
    }),
  },
} as const satisfies Record<string, HarnessProfile>;

export type BuiltinHarnessId = keyof typeof BUILTIN_HARNESS_PROFILES;

export const BUILTIN_HARNESS_IDS = Object.freeze(
  Object.keys(BUILTIN_HARNESS_PROFILES) as BuiltinHarnessId[],
);

export function isBuiltinHarness(id: string): id is BuiltinHarnessId {
  return Object.hasOwn(BUILTIN_HARNESS_PROFILES, id);
}

export function builtinHarnessProfile(id: string): HarnessProfile | undefined {
  return isBuiltinHarness(id) ? BUILTIN_HARNESS_PROFILES[id] : undefined;
}

export function validateHarnessEffort(id: string, effort: string | undefined): void {
  if (!effort) return;
  const profile = builtinHarnessProfile(id);
  if (!profile) throw new Error(`unknown harness ${JSON.stringify(id)}`);
  if (!profile.effortValues.includes(effort)) {
    const supportedValues = profile.effortValues.length ? profile.effortValues.join(", ") : "none";
    throw new Error(
      `effort ${JSON.stringify(effort)} is not supported by ${id}; supported values: ${supportedValues}`,
    );
  }
}
