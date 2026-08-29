import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import type { HarneryConversationCatalog } from "../core/conversations/catalog.ts";
import { buildConversationContextPack } from "../core/conversations/context-pack.ts";
import type {
  HarneryConversationQueryRequest,
  HarneryConversationRecordV1,
  HarneryConversationRole,
} from "../core/conversations/contract.ts";
import {
  type HarneryConversationPurgePlan,
  planConversationPurge,
  validatePurgeExecutionRequest,
} from "../core/conversations/lifecycle.ts";
import { queryConversationCatalog } from "../core/conversations/query.ts";

export interface RegisterConversationsOptions {
  project_scope_id: string;
  records?: () => readonly HarneryConversationRecordV1[];
}

export function registerConversationsCommand(
  program: Command,
  emit: EmitContext,
  catalog?: HarneryConversationCatalog,
  dependencies?: RegisterConversationsOptions,
): void {
  const pendingPlans = new Map<string, HarneryConversationPurgePlan>();
  const conversations = program.command("conversations").description("Query conversation evidence");

  conversations
    .command("list")
    .option("--provider <id>")
    .option("--project <id>")
    .option("--json")
    .action(async (options: { provider?: string; project?: string; json?: boolean }) => {
      await run(emit, async () => {
        const configured = requireConversations(catalog, dependencies);
        const project = exactProject(configured.dependencies.project_scope_id, options.project);
        const providers = options.provider
          ? [configured.catalog.require(options.provider)]
          : configured.catalog.list();
        const rows = (
          await Promise.all(
            providers.map(async (provider) =>
              provider.capabilities.can_list ? provider.list(project) : [],
            ),
          )
        ).flat();
        if (options.json) {
          emit.config({ format: "json" });
          emit.data({ schema: "harnery.conversation-list/v1", project_scope_id: project, rows });
        } else emit.rows(rows as unknown as Record<string, unknown>[]);
      });
    });

  addQueryOptions(conversations.command("query"))
    .option("--json")
    .action(async (options: QueryOptions) => {
      await run(emit, async () => {
        const configured = requireConversations(catalog, dependencies);
        const result = await queryConversationCatalog(
          configured.catalog,
          request(configured.dependencies, options),
        );
        if (options.json) {
          emit.config({ format: "json" });
          emit.data(result);
        } else {
          emit.rows(
            result.hits.map(({ record, citation }) => ({
              ...citation,
              content: record.content,
            })),
          );
        }
      });
    });

  addQueryOptions(conversations.command("context"))
    .option("--max-tokens <count>", "Token ceiling", parsePositive, 2_000)
    .option("--max-bytes <count>", "Byte ceiling", parsePositive, 16_000)
    .option("--json")
    .action(
      async (options: QueryOptions & { maxTokens: number; maxBytes: number; json?: boolean }) => {
        await run(emit, async () => {
          const configured = requireConversations(catalog, dependencies);
          const result = await queryConversationCatalog(
            configured.catalog,
            request(configured.dependencies, options),
          );
          const pack = buildConversationContextPack(result, {
            max_tokens: options.maxTokens,
            max_bytes: options.maxBytes,
          });
          if (options.json) emit.config({ format: "json" });
          emit.data(pack);
        });
      },
    );

  conversations
    .command("archive")
    .requiredOption("--mode <mode>", "off | source | archive")
    .option("--authority <mode>", "shadow | cutover | rollback", "shadow")
    .option("--yes", "Reserved for a future checked capture transaction")
    .action((options: { mode: string; authority: string; yes?: boolean }) => {
      const validMode = ["off", "source", "archive"].includes(options.mode);
      const validAuthority = ["shadow", "cutover", "rollback"].includes(options.authority);
      if (!validMode || !validAuthority) {
        emit.error({ code: "conversation_archive_mode_invalid", message: "invalid archive mode" });
        emit.setExitCode(1);
        return;
      }
      emit.data({
        schema: "harnery.conversation-archive-plan/v1",
        access_mode: options.mode,
        authority_mode: options.authority,
        dry_run: true,
        writes: false,
        execution_enabled: false,
      });
    });

  conversations
    .command("purge")
    .option("--conversation <id>")
    .option("--before <time>")
    .option("--transaction <id>")
    .option("--yes")
    .option("--json")
    .action(
      (options: {
        conversation?: string;
        before?: string;
        transaction?: string;
        yes?: boolean;
        json?: boolean;
      }) => {
        try {
          const configured = requireConversations(catalog, dependencies);
          if (options.transaction) {
            const plan = pendingPlans.get(options.transaction);
            if (!plan) throw new Error(`unknown purge transaction: ${options.transaction}`);
            const result = validatePurgeExecutionRequest(
              plan,
              options.transaction,
              options.yes ?? false,
            );
            if (options.json) emit.config({ format: "json" });
            emit.data({ schema: "harnery.conversation-purge-result/v1", ...result });
            if (result.reason_code !== "execution_disabled") emit.setExitCode(1);
            return;
          }
          const plan = planConversationPurge({
            records: configured.dependencies.records?.() ?? [],
            project_scope_id: configured.dependencies.project_scope_id,
            ...(options.conversation ? { conversation_id: options.conversation } : {}),
            ...(options.before ? { before: options.before } : {}),
          });
          pendingPlans.set(plan.transaction_id, plan);
          if (options.json) emit.config({ format: "json" });
          emit.data(plan);
        } catch (error) {
          emit.error({
            code: "conversation_purge_failed",
            message: error instanceof Error ? error.message : String(error),
          });
          emit.setExitCode(1);
        }
      },
    );
}

function requireConversations(
  catalog?: HarneryConversationCatalog,
  dependencies?: RegisterConversationsOptions,
): {
  catalog: HarneryConversationCatalog;
  dependencies: RegisterConversationsOptions;
} {
  if (!catalog || !dependencies)
    throw new Error("conversation providers are not configured by this host");
  return { catalog, dependencies };
}

interface QueryOptions {
  text?: string;
  regex?: string;
  role?: string;
  since?: string;
  until?: string;
  project?: string;
  provider?: string;
  session?: string;
  conversation?: string;
  record?: string;
  limit: number;
  contextBefore: number;
  contextAfter: number;
  json?: boolean;
}

function addQueryOptions(command: Command): Command {
  return command
    .option("--text <literal>")
    .option("--regex <pattern>")
    .option("--role <role>")
    .option("--since <time>")
    .option("--until <time>")
    .option("--project <id>")
    .option("--provider <id>")
    .option("--session <id>")
    .option("--conversation <id>")
    .option("--record <id>")
    .option("--limit <count>", "Match ceiling", parsePositive, 20)
    .option("--context-before <count>", "Earlier neighbors", parseNonnegative, 0)
    .option("--context-after <count>", "Later neighbors", parseNonnegative, 0);
}

function request(
  dependencies: RegisterConversationsOptions,
  options: QueryOptions,
): HarneryConversationQueryRequest {
  const role = options.role as HarneryConversationRole | undefined;
  return {
    project_scope_id: exactProject(dependencies.project_scope_id, options.project),
    limit: options.limit,
    context_before: options.contextBefore,
    context_after: options.contextAfter,
    budgets: {
      max_source_records: 10_000,
      max_decoded_bytes: 16 * 1_024 * 1_024,
      max_matches: options.limit,
      max_wall_ms: 5_000,
      max_regex_chars: 256,
    },
    ...(options.text ? { text: options.text } : {}),
    ...(options.regex ? { regex: options.regex } : {}),
    ...(role ? { role } : {}),
    ...(options.since ? { since: options.since } : {}),
    ...(options.until ? { until: options.until } : {}),
    ...(options.provider ? { provider_id: options.provider } : {}),
    ...(options.session ? { session_id: options.session } : {}),
    ...(options.conversation ? { conversation_id: options.conversation } : {}),
    ...(options.record ? { record_id: options.record } : {}),
  };
}

function exactProject(expected: string, requested?: string): string {
  if (requested && requested !== expected)
    throw new Error("cross-project conversation access denied");
  return expected;
}

function parsePositive(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("expected a positive integer");
  return parsed;
}

function parseNonnegative(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error("expected a nonnegative integer");
  return parsed;
}

async function run(emit: EmitContext, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    emit.error({
      code: "conversation_command_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    emit.setExitCode(1);
  }
}
