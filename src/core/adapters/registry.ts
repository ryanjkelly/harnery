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
  BUILTIN_ADAPTER_IDS,
  BUILTIN_ADAPTER_PROFILES,
  type BuiltinAdapterId,
} from "./profiles.ts";
import type { Adapter, AdapterId } from "./types.ts";

const BUILTIN_ADAPTERS: Record<BuiltinAdapterId, Adapter> = {
  "claude-code": {
    profile: BUILTIN_ADAPTER_PROFILES["claude-code"],
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
    profile: BUILTIN_ADAPTER_PROFILES.codex,
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
    profile: BUILTIN_ADAPTER_PROFILES.cursor,
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
export class AdapterRegistry {
  readonly #adapters = new Map<AdapterId, Adapter>();

  constructor(adapters: Iterable<Adapter> = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: Adapter): this {
    const id = adapter.profile.id.trim();
    if (!id) throw new Error("adapter adapter id cannot be empty");
    if (this.#adapters.has(id))
      throw new Error(`adapter adapter ${JSON.stringify(id)} is already registered`);
    if (adapter.profile.binary.trim() === "") {
      throw new Error(`adapter adapter ${JSON.stringify(id)} has no binary`);
    }
    this.#adapters.set(id, adapter);
    return this;
  }

  get(id: AdapterId): Adapter | undefined {
    return this.#adapters.get(id);
  }

  require(id: AdapterId): Adapter {
    const adapter = this.get(id);
    if (!adapter) {
      throw new Error(
        `unknown adapter ${JSON.stringify(id)} (registered: ${this.ids().join(", ") || "none"})`,
      );
    }
    return adapter;
  }

  list(): Adapter[] {
    return Array.from(this.#adapters.values());
  }

  ids(): AdapterId[] {
    return Array.from(this.#adapters.keys());
  }

  spawners(): Record<AdapterId, Adapter["spawn"]> {
    return Object.fromEntries(this.list().map((adapter) => [adapter.profile.id, adapter.spawn]));
  }
}

export function createBuiltinAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry(BUILTIN_ADAPTER_IDS.map((id) => BUILTIN_ADAPTERS[id]));
}
