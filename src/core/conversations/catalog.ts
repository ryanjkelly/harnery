import type { HarneryConversationProvider } from "./contract.ts";

export class HarneryConversationCatalog {
  readonly #providers: ReadonlyMap<string, HarneryConversationProvider>;

  constructor(providers: readonly HarneryConversationProvider[]) {
    const entries = new Map<string, HarneryConversationProvider>();
    for (const provider of providers) {
      const id = provider.capabilities.provider_id;
      if (!/^[a-z][a-z0-9-]{1,63}$/.test(id))
        throw new Error(`invalid conversation provider id: ${id}`);
      if (entries.has(id)) throw new Error(`duplicate conversation provider: ${id}`);
      if (provider.capabilities.roles.some((role) => role !== "user" && role !== "assistant")) {
        throw new Error(`provider ${id} exposes an excluded role`);
      }
      entries.set(id, Object.freeze(provider));
    }
    this.#providers = entries;
  }

  get(id: string): HarneryConversationProvider | undefined {
    return this.#providers.get(id);
  }

  require(id: string): HarneryConversationProvider {
    const provider = this.get(id);
    if (!provider) throw new Error(`unknown conversation provider: ${id}`);
    return provider;
  }

  list(): readonly HarneryConversationProvider[] {
    return [...this.#providers.values()].sort((left, right) =>
      left.capabilities.provider_id.localeCompare(right.capabilities.provider_id),
    );
  }
}

export function unavailableAdapterProviders(): readonly HarneryConversationProvider[] {
  return ["claude-code", "codex", "cursor"].map((providerId) => ({
    capabilities: {
      provider_id: providerId,
      roles: ["user", "assistant"] as const,
      can_list: false,
      can_stream_source: false,
      can_replay_archive: false,
      default_completeness: "unavailable" as const,
      default_omissions: [
        "adapter-native source reader is not registered by this host",
        "system, developer, tool, reasoning, command, and attachment bodies are excluded",
      ],
      retention_behavior: "adapter-owned and unavailable to portable core",
    },
    async list() {
      return [];
    },
    async snapshot(projectScopeId: string, conversationId: string) {
      return {
        snapshot_id: `${providerId}:unavailable:${conversationId}`,
        provider_id: providerId,
        project_scope_id: projectScopeId,
        conversation_id: conversationId,
        observed_at: new Date().toISOString(),
        completeness: "unavailable" as const,
        omissions: ["adapter-native source unavailable"],
      };
    },
    stream() {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<never>> {
              throw new Error(`conversation provider unavailable: ${providerId}`);
            },
          };
        },
      };
    },
  }));
}
