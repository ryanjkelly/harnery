import {
  buildClaudeInvocation,
  claudeCodeSpawner,
  normalizeClaudeResult,
} from "../workflow/spawn-claude.ts";
import {
  buildCodexInvocation,
  codexSpawner,
  normalizeCodexResult,
} from "../workflow/spawn-codex.ts";
import {
  buildCursorInvocation,
  cursorSpawner,
  normalizeCursorResult,
} from "../workflow/spawn-cursor.ts";
import {
  BUILTIN_HARNESS_IDS,
  BUILTIN_HARNESS_PROFILES,
  type BuiltinHarnessId,
} from "./profiles.ts";
import type { HarnessAdapter, HarnessId } from "./types.ts";

const BUILTIN_ADAPTERS: Record<BuiltinHarnessId, HarnessAdapter> = {
  "claude-code": {
    profile: BUILTIN_HARNESS_PROFILES["claude-code"],
    spawn: claudeCodeSpawner,
    buildInvocation: buildClaudeInvocation,
    normalizeResult: normalizeClaudeResult,
    fixture: {
      raw: {
        stdout: JSON.stringify({
          type: "result",
          result: "HARNERY_BENCH_OK",
          session_id: "claude-bench-session",
          total_cost_usd: 0.0012,
        }),
        stderr: "",
        exitCode: 0,
        durationMs: 12,
      },
      expected: {
        ok: true,
        text: "HARNERY_BENCH_OK",
        sessionId: "claude-bench-session",
        costUsd: 0.0012,
      },
    },
  },
  codex: {
    profile: BUILTIN_HARNESS_PROFILES.codex,
    spawn: codexSpawner,
    buildInvocation: buildCodexInvocation,
    normalizeResult: normalizeCodexResult,
    fixture: {
      raw: {
        stdout: "event stream is not the final answer",
        stderr: "",
        exitCode: 0,
        durationMs: 14,
        resultFileText: "HARNERY_BENCH_OK\n",
      },
      expected: { ok: true, text: "HARNERY_BENCH_OK" },
    },
  },
  cursor: {
    profile: BUILTIN_HARNESS_PROFILES.cursor,
    spawn: cursorSpawner,
    buildInvocation: buildCursorInvocation,
    normalizeResult: normalizeCursorResult,
    fixture: {
      raw: {
        stdout: JSON.stringify({
          type: "result",
          result: "HARNERY_BENCH_OK",
          session_id: "cursor-bench-session",
        }),
        stderr: "",
        exitCode: 0,
        durationMs: 9,
      },
      expected: {
        ok: true,
        text: "HARNERY_BENCH_OK",
        sessionId: "cursor-bench-session",
      },
    },
  },
};

/** Mutable registry for embedders, initialized empty unless adapters are
 * provided. Duplicate ids fail loud instead of silently replacing behavior. */
export class HarnessRegistry {
  readonly #adapters = new Map<HarnessId, HarnessAdapter>();

  constructor(adapters: Iterable<HarnessAdapter> = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: HarnessAdapter): this {
    const id = adapter.profile.id.trim();
    if (!id) throw new Error("harness adapter id cannot be empty");
    if (this.#adapters.has(id))
      throw new Error(`harness adapter ${JSON.stringify(id)} is already registered`);
    if (adapter.profile.binary.trim() === "") {
      throw new Error(`harness adapter ${JSON.stringify(id)} has no binary`);
    }
    this.#adapters.set(id, adapter);
    return this;
  }

  get(id: HarnessId): HarnessAdapter | undefined {
    return this.#adapters.get(id);
  }

  require(id: HarnessId): HarnessAdapter {
    const adapter = this.get(id);
    if (!adapter) {
      throw new Error(
        `unknown harness ${JSON.stringify(id)} (registered: ${this.ids().join(", ") || "none"})`,
      );
    }
    return adapter;
  }

  list(): HarnessAdapter[] {
    return Array.from(this.#adapters.values());
  }

  ids(): HarnessId[] {
    return Array.from(this.#adapters.keys());
  }

  spawners(): Record<HarnessId, HarnessAdapter["spawn"]> {
    return Object.fromEntries(this.list().map((adapter) => [adapter.profile.id, adapter.spawn]));
  }
}

export function createBuiltinHarnessRegistry(): HarnessRegistry {
  return new HarnessRegistry(BUILTIN_HARNESS_IDS.map((id) => BUILTIN_ADAPTERS[id]));
}
