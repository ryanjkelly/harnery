import type { HarneryConversationRecordV1 } from "./contract.ts";
import { digest } from "./normalize.ts";

export interface HarneryConversationSearchIndexV1 {
  schema: "harnery.conversation-search-index/v1";
  source_digest: `sha256:${string}`;
  terms: Readonly<Record<string, readonly string[]>>;
}

export function buildConversationSearchIndex(
  records: readonly HarneryConversationRecordV1[],
): HarneryConversationSearchIndexV1 {
  const terms = new Map<string, Set<string>>();
  const ordered = [...records].sort((left, right) => left.record_id.localeCompare(right.record_id));
  for (const record of ordered) {
    for (const term of record.content.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []) {
      const ids = terms.get(term) ?? new Set<string>();
      ids.add(record.record_id);
      terms.set(term, ids);
    }
  }
  return {
    schema: "harnery.conversation-search-index/v1",
    source_digest: digest(
      ordered.map((record) => `${record.record_id}:${record.content_digest}`).join("\n"),
    ),
    terms: Object.fromEntries(
      [...terms]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([term, ids]) => [term, [...ids].sort()]),
    ),
  };
}

export function verifyIndexedRecords(
  index: HarneryConversationSearchIndexV1,
  records: readonly HarneryConversationRecordV1[],
  term: string,
): HarneryConversationRecordV1[] {
  const byId = new Map(records.map((record) => [record.record_id, record]));
  return (index.terms[term.toLocaleLowerCase()] ?? []).map((id) => {
    const record = byId.get(id);
    if (!record?.content.toLocaleLowerCase().includes(term.toLocaleLowerCase())) {
      throw new Error(`stale conversation index hit: ${id}`);
    }
    return record;
  });
}
