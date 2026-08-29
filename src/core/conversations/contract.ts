export type HarneryConversationRole = "user" | "assistant";
export type HarneryConversationCompleteness = "complete" | "partial" | "unavailable";
export type HarneryConversationAccessMode = "off" | "source" | "archive";
export type HarneryConversationArchiveAuthorityMode = "shadow" | "cutover" | "rollback";

export interface HarneryConversationProviderCapabilities {
  provider_id: string;
  roles: readonly HarneryConversationRole[];
  can_list: boolean;
  can_stream_source: boolean;
  can_replay_archive: boolean;
  default_completeness: HarneryConversationCompleteness;
  default_omissions: readonly string[];
  retention_behavior: string;
}

export interface HarneryConversationSourceSnapshot {
  snapshot_id: string;
  provider_id: string;
  project_scope_id: string;
  conversation_id: string;
  checkpoint?: string;
  observed_at: string;
  completeness: HarneryConversationCompleteness;
  omissions: readonly string[];
}

export interface HarneryConversationRecordV1 {
  schema: "harnery.conversation-record/v1";
  record_id: string;
  provider_id: string;
  project_scope_id: string;
  conversation_id: string;
  source_snapshot_id: string;
  session_id?: string;
  turn_id?: string;
  source: {
    native_conversation_id: string;
    native_record_id?: string;
    native_sequence?: number;
    source_digest?: `sha256:${string}`;
  };
  sequence: number;
  occurred_at: string;
  captured_at: string;
  role: HarneryConversationRole;
  content: string;
  content_bytes: number;
  content_digest: `sha256:${string}`;
  redactions: readonly {
    kind: string;
    replacement: string;
    stored_start: number;
    stored_end: number;
    source_bytes_removed: number;
  }[];
  attachment_refs: readonly string[];
  sensitivity: "private";
}

export interface HarneryConversationSummary {
  provider_id: string;
  project_scope_id: string;
  conversation_id: string;
  snapshot_id: string;
  completeness: HarneryConversationCompleteness;
  omissions: readonly string[];
  record_count?: number;
}

export interface HarneryConversationCitation {
  record_id: string;
  provider_id: string;
  conversation_id: string;
  role: HarneryConversationRole;
  occurred_at: string;
  native_conversation_id: string;
  native_record_id?: string;
  content_digest: `sha256:${string}`;
}

export interface HarneryConversationQueryRequest {
  text?: string;
  regex?: string;
  provider_id?: string;
  role?: HarneryConversationRole;
  since?: string;
  until?: string;
  project_scope_id: string;
  session_id?: string;
  conversation_id?: string;
  record_id?: string;
  limit: number;
  context_before?: number;
  context_after?: number;
  budgets: HarneryConversationQueryBudgets;
}

export interface HarneryConversationQueryBudgets {
  max_source_records: number;
  max_decoded_bytes: number;
  max_matches: number;
  max_wall_ms: number;
  max_regex_chars: number;
}

export interface HarneryConversationQueryHit {
  record: HarneryConversationRecordV1;
  citation: HarneryConversationCitation;
  neighbors: readonly HarneryConversationRecordV1[];
}

export interface HarneryConversationQueryResult {
  schema: "harnery.conversation-query/v1";
  request: HarneryConversationQueryRequest;
  hits: readonly HarneryConversationQueryHit[];
  scanned_records: number;
  decoded_bytes: number;
  truncated: boolean;
  truncation_reason?: "record_budget" | "byte_budget" | "match_budget" | "wall_budget";
  snapshots: readonly HarneryConversationSourceSnapshot[];
}

export interface HarneryConversationContextPack {
  schema: "harnery.conversation-context-pack/v1";
  boundary: "untrusted-historical-data";
  automatic_injection: false;
  project_scope_id: string;
  excerpts: readonly {
    citation: HarneryConversationCitation;
    content: string;
    sequence: number;
  }[];
  completeness: readonly {
    provider_id: string;
    conversation_id: string;
    completeness: HarneryConversationCompleteness;
    omissions: readonly string[];
  }[];
  bytes: number;
  estimated_tokens: number;
  truncated: boolean;
}

export interface HarneryNativeConversationRecord {
  native_conversation_id: string;
  native_record_id?: string;
  native_sequence?: number;
  role: string;
  occurred_at: string;
  content: string;
  session_id?: string;
  turn_id?: string;
  attachment_refs?: readonly string[];
}

export interface HarneryConversationProviderReadOptions {
  /** Providers should stop pending I/O promptly when the query wall budget expires. */
  signal?: AbortSignal;
}

export interface HarneryConversationProvider {
  capabilities: HarneryConversationProviderCapabilities;
  list(
    projectScopeId: string,
    options?: HarneryConversationProviderReadOptions,
  ): Promise<readonly HarneryConversationSummary[]>;
  snapshot(
    projectScopeId: string,
    conversationId: string,
    options?: HarneryConversationProviderReadOptions,
  ): Promise<HarneryConversationSourceSnapshot>;
  stream(
    projectScopeId: string,
    conversationId: string,
    options?: HarneryConversationProviderReadOptions,
  ): AsyncIterable<HarneryNativeConversationRecord>;
}
